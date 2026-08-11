/**
 * Bonsai Supply — 행어 재고 콘솔 (프론트 셸)
 *
 * 데이터는 window.BONSAI_MOCK, 시세는 window.BonsaiPricing 에서 온다.
 * API 연결 시 loadItems() 와 pricing.js 의 provider 두 곳만 바꾸면 된다.
 */
(function () {
    "use strict";

    /**
     * EVE 이미지 서버. 인증이 없고 CORS가 전면 개방(`Access-Control-Allow-Origin: *`)이라
     * 정적 호스팅에서 브라우저가 바로 때릴 수 있다. typeId 하나로 아이콘이 나오므로
     * SDE를 받아 typeId→아이콘 매핑을 따로 만들 필요가 없다.
     * 64px을 받아 32px로 그린다 — 고밀도 디스플레이 대응.
     */
    var ICON_BASE = "https://images.evetech.net/types/";
    var SPARK_W = 96;
    var SPARK_H = 22;

    /* typeId 아이콘이 아직 없을 때 쓰는 자리표시자. 파일 요청을 만들지 않도록 인라인 SVG. */
    var ICON_FALLBACK =
        "data:image/svg+xml;utf8," +
        encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">' +
                '<rect width="32" height="32" fill="#0B0F14"/>' +
                '<path d="M10 9h-3v14h3M22 9h3v14h-3" stroke="#39485a" stroke-width="1.5" fill="none"/>' +
                '<rect x="14" y="14" width="4" height="4" fill="#39485a"/>' +
                "</svg>"
        );

    var state = {
        items: [],
        filter: "short",
        query: "",
        excluded: new Set(), // 기본은 "부족분 전부 포함", 사용자가 뺀 것만 기록한다
        unitPrices: {},
        priceSource: "—",
        sampledAt: Date.now(),
        sampleMs: 10 * 60 * 1000,
        firstPaint: true,
    };

    var el = {
        rows: document.querySelector("[data-rows]"),
        empty: document.querySelector("[data-empty]"),
        slab: document.querySelector("[data-slab]"),
        copy: document.querySelector("[data-copy]"),
        toast: document.querySelector("[data-toast]"),
        query: document.getElementById("q"),
        hangar: document.getElementById("hangar"),
        sync: document.querySelector("[data-sync]"),
        priceSource: document.querySelector("[data-price-source]"),
        historyWindow: document.querySelector("[data-history-window]"),
        sampleMinutes: document.querySelector("[data-sample-minutes]"),
        manifestLines: document.querySelector("[data-manifest-lines]"),
        manifestVolume: document.querySelector("[data-manifest-volume]"),
        manifestIsk: document.querySelector("[data-manifest-isk]"),
    };

    /* ── 숫자 표기 ───────────────────────────────────────── */

    var nf = new Intl.NumberFormat("ko-KR");

    function num(n) {
        return nf.format(Math.round(n));
    }

    function volume(m3) {
        if (m3 >= 1000) return nf.format(Math.round(m3));
        if (m3 >= 1) return nf.format(Math.round(m3 * 10) / 10);
        return String(Math.round(m3 * 100) / 100);
    }

    /**
     * T / B / M 까지만 줄여 쓴다. K는 실제로 잘 쓰지 않아 오히려 읽기 어렵다.
     * 접미사가 붙으면 그 자체로 금액이라는 신호가 되지만, 그 아래는 숫자만 남아 모호해진다.
     * 그래서 M 미만에만 단위를 붙인다.
     */
    function isk(n) {
        if (!isFinite(n) || n <= 0) return "—";
        if (n >= 1e12) return (n / 1e12).toFixed(2) + "T";
        if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
        if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
        return num(n) + " isk";
    }

    /** 매니페스트 합계용 — 항상 단위를 달되 중복되지 않게 한다. */
    function iskTotal(n) {
        var s = isk(n);
        return s.slice(-4) === " isk" ? s.slice(0, -4) + " ISK" : s + " ISK";
    }

    /** "8/10 19:30" — ko-KR 기본 포맷("8. 10. 19:30")은 마침표가 많아 표에서 지저분하다. */
    function whenLabel(d) {
        var p = function (n) {
            return n < 10 ? "0" + n : String(n);
        };
        return (
            d.getMonth() + 1 + "/" + d.getDate() + " " + p(d.getHours()) + ":" + p(d.getMinutes())
        );
    }

    /* ── 재고 수준 → 색 ─────────────────────────────────── */

    var RAMP = { low: [224, 91, 79], mid: [232, 163, 61], high: [82, 183, 136] };

    /**
     * 충족률(0~1+)을 레드→앰버→그린 사이에서 연속 보간한다.
     * 0.5 지점이 앰버 — "절반이면 주의"가 색으로 읽힌다.
     *
     * 두 구간 모두 선형 대신 이징을 쓴다. 선형으로 섞으면 20%짜리가 이미 주황으로 보여서
     * 정작 위험한 저재고가 덜 위험해 보인다. 아래쪽은 레드를 오래 붙들고,
     * 위쪽은 목표에 거의 닿아야 그린이 된다.
     */
    function rampColor(ratio) {
        var t = Math.max(0, Math.min(1, ratio));
        var from, to, k;
        if (t < 0.5) {
            from = RAMP.low;
            to = RAMP.mid;
            k = Math.pow(t / 0.5, 1.8);
        } else {
            from = RAMP.mid;
            to = RAMP.high;
            k = Math.pow((t - 0.5) / 0.5, 1.3);
        }
        var c = from.map(function (v, i) {
            return Math.round(v + (to[i] - v) * k);
        });
        return "rgb(" + c.join(",") + ")";
    }

    /* ── 파생값 ─────────────────────────────────────────── */

    function deficit(item) {
        return Math.max(0, item.target - item.stocked);
    }

    function isShort(item) {
        return deficit(item) > 0;
    }

    function included(item) {
        return isShort(item) && !state.excluded.has(item.name);
    }

    function ratioOf(item) {
        return item.target > 0 ? item.stocked / item.target : 1;
    }

    function unitPrice(item) {
        return state.unitPrices[item.name] || 0;
    }

    function lineCost(item) {
        return deficit(item) * unitPrice(item);
    }

    function iconSrc(item) {
        if (!item.typeId) return ICON_FALLBACK;
        return ICON_BASE + item.typeId + "/icon?size=64";
    }

    /* ── 데이터 적재 ─────────────────────────────────────── */

    function loadItems() {
        // API 연결 시 이 함수만 fetch("/api/stock") 로 교체한다.
        var mock = window.BONSAI_MOCK || { items: [] };
        if (el.sync && mock.syncedAt) el.sync.textContent = mock.syncedAt;
        if (el.historyWindow && mock.historyHours) {
            el.historyWindow.textContent = String(mock.historyHours);
        }
        if (mock.sampleMinutes) {
            state.sampleMs = mock.sampleMinutes * 60 * 1000;
            if (el.sampleMinutes) el.sampleMinutes.textContent = String(mock.sampleMinutes);
        }
        if (mock.sampledAt) state.sampledAt = new Date(mock.sampledAt).getTime();
        if (el.hangar && mock.hangar) {
            for (var i = 0; i < el.hangar.options.length; i++) {
                if (el.hangar.options[i].text === mock.hangar) el.hangar.selectedIndex = i;
            }
        }
        return (mock.items || []).map(function (raw) {
            return {
                typeId: raw.typeId,
                name: raw.name,
                group: raw.group,
                stocked: raw.stocked,
                target: raw.target,
                unitVolume: raw.unitVolume,
                history: raw.history || [],
            };
        });
    }

    function loadPrices() {
        if (!window.BonsaiPricing) return;
        window.BonsaiPricing.fetchPrices(state.items).then(function (result) {
            state.unitPrices = result.unitPrices || {};
            state.priceSource = result.source || "—";
            render();
        });
    }

    /* ── 표시 대상 ──────────────────────────────────────── */

    function visibleItems() {
        var q = state.query.trim().toLowerCase();
        return state.items.filter(function (item) {
            if (state.filter === "short" && !isShort(item)) return false;
            if (state.filter === "ok" && isShort(item)) return false;
            if (!q) return true;
            return (
                item.name.toLowerCase().indexOf(q) !== -1 ||
                String(item.group || "")
                    .toLowerCase()
                    .indexOf(q) !== -1
            );
        });
    }

    /* ── 렌더: 충족률 바 ────────────────────────────────── */

    function buildBar(item, index) {
        var ratio = ratioOf(item);
        var pct = Math.round(ratio * 100);
        var color = rampColor(ratio);

        var track = document.createElement("div");
        track.className = "bar__track";
        track.style.setProperty("--fill", color);
        track.setAttribute("role", "img");
        track.setAttribute("aria-label", "목표 대비 " + pct + "%");

        var fill = document.createElement("div");
        fill.className = "bar__fill" + (state.firstPaint ? " is-new" : "");
        fill.style.width = Math.min(100, Math.max(ratio > 0 ? 2 : 0, pct)) + "%";
        if (state.firstPaint) fill.style.setProperty("--d", Math.min(index, 12) * 28 + "ms");
        track.appendChild(fill);

        if (ratio > 1) {
            var over = document.createElement("span");
            over.className = "bar__over";
            track.appendChild(over);
        }

        // 퍼센트는 트랙 안에 얹는다 — 별도 칸을 쓰지 않아 열이 그만큼 좁아진다.
        var label = document.createElement("span");
        label.className = "bar__pct";
        label.textContent = pct + "%";
        track.appendChild(label);

        return track;
    }

    /* ── 렌더: 추이 스파크라인 ──────────────────────────── */

    function buildSpark(item) {
        var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", "spark");
        svg.setAttribute("viewBox", "0 0 " + SPARK_W + " " + SPARK_H);
        svg.setAttribute("preserveAspectRatio", "none");
        svg.setAttribute("role", "img");
        svg.style.setProperty("--fill", rampColor(ratioOf(item)));

        var data = item.history;
        if (!data || data.length < 2) {
            svg.setAttribute("aria-label", "추이 기록 없음");
            return svg;
        }

        var max = Math.max.apply(null, data);
        var min = Math.min.apply(null, data);
        var span = max - min || 1;
        var stepX = SPARK_W / (data.length - 1);

        var pts = data.map(function (v, i) {
            var x = i * stepX;
            // 위아래로 1px 여백을 남겨 선이 잘리지 않게 한다.
            var y = SPARK_H - 1 - ((v - min) / span) * (SPARK_H - 2);
            return [x, y];
        });

        var line = pts
            .map(function (p) {
                return p[0].toFixed(1) + "," + p[1].toFixed(1);
            })
            .join(" ");

        var area = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
        area.setAttribute("class", "spark__area");
        area.setAttribute("points", "0," + SPARK_H + " " + line + " " + SPARK_W + "," + SPARK_H);
        svg.appendChild(area);

        var path = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
        path.setAttribute("class", "spark__line");
        path.setAttribute("vector-effect", "non-scaling-stroke");
        path.setAttribute("points", line);
        svg.appendChild(path);

        var last = pts[pts.length - 1];
        var dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        dot.setAttribute("class", "spark__now");
        dot.setAttribute("cx", String(SPARK_W - 1));
        dot.setAttribute("cy", last[1].toFixed(1));
        dot.setAttribute("r", "1.8");
        svg.appendChild(dot);

        attachSparkHover(svg, item, data, pts);

        var change = data[data.length - 1] - data[0];
        svg.setAttribute(
            "aria-label",
            "최근 추이 " +
                num(data[0]) +
                " → " +
                num(data[data.length - 1]) +
                (change === 0 ? ", 변동 없음" : change < 0 ? ", " + num(-change) + " 감소" : ", " + num(change) + " 증가")
        );
        return svg;
    }

    /* ── 추이 hover: 그 시점의 날짜와 수량 ──────────────── */

    var tip = document.querySelector("[data-tip]");

    /** 마지막 표본이 "지금"이고, 한 칸 왼쪽이 sampleMinutes 만큼 과거다. */
    function timeAt(index, length) {
        return new Date(state.sampledAt - (length - 1 - index) * state.sampleMs);
    }

    function showTip(clientX, rect, item, index, data) {
        tip.textContent = "";
        tip.style.setProperty("--fill", rampColor(ratioOf(item)));

        var when = document.createElement("span");
        when.className = "tip__when";
        when.textContent = whenLabel(timeAt(index, data.length));

        var qty = document.createElement("span");
        qty.className = "tip__qty";
        qty.textContent = "  " + num(data[index]) + "개";

        tip.appendChild(when);
        tip.appendChild(qty);
        tip.hidden = false;

        // 커서 위에 띄우되 화면 밖으로 나가지 않게 잡아 둔다.
        var w = tip.offsetWidth;
        var x = Math.max(6, Math.min(window.innerWidth - w - 6, clientX - w / 2));
        var y = rect.top - tip.offsetHeight - 8;
        if (y < 6) y = rect.bottom + 8;
        tip.style.left = x + "px";
        tip.style.top = y + "px";
    }

    function hideTip() {
        tip.hidden = true;
    }

    function attachSparkHover(svg, item, data, pts) {
        var ns = "http://www.w3.org/2000/svg";

        var guide = document.createElementNS(ns, "line");
        guide.setAttribute("class", "spark__guide");
        guide.setAttribute("vector-effect", "non-scaling-stroke");
        guide.setAttribute("y1", "0");
        guide.setAttribute("y2", String(SPARK_H));
        guide.style.display = "none";
        svg.appendChild(guide);

        var hit = document.createElementNS(ns, "circle");
        hit.setAttribute("class", "spark__hit");
        hit.setAttribute("r", "2.2");
        hit.style.display = "none";
        svg.appendChild(hit);

        svg.addEventListener("pointermove", function (e) {
            var rect = svg.getBoundingClientRect();
            if (!rect.width) return;
            var k = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            var i = Math.round(k * (data.length - 1));

            guide.setAttribute("x1", pts[i][0].toFixed(1));
            guide.setAttribute("x2", pts[i][0].toFixed(1));
            guide.style.display = "";
            hit.setAttribute("cx", pts[i][0].toFixed(1));
            hit.setAttribute("cy", pts[i][1].toFixed(1));
            hit.style.display = "";

            showTip(e.clientX, rect, item, i, data);
        });

        svg.addEventListener("pointerleave", function () {
            guide.style.display = "none";
            hit.style.display = "none";
            hideTip();
        });
    }

    /* ── 렌더: 행 ───────────────────────────────────────── */

    function buildRow(item, index) {
        var short = deficit(item);
        var tr = document.createElement("tr");
        tr.className = "row" + (short && state.excluded.has(item.name) ? " is-out" : "");

        // 포함 토글
        var tdPick = document.createElement("td");
        tdPick.className = "tbl__pick";
        if (short) {
            var box = document.createElement("input");
            box.type = "checkbox";
            box.className = "pick";
            box.checked = included(item);
            box.setAttribute("aria-label", item.name + " 매니페스트에 포함");
            box.addEventListener("change", function () {
                if (box.checked) state.excluded.delete(item.name);
                else state.excluded.add(item.name);
                render();
            });
            tdPick.appendChild(box);
        }
        tr.appendChild(tdPick);

        // 아이콘
        var tdIco = document.createElement("td");
        tdIco.className = "tbl__ico";
        var img = document.createElement("img");
        img.className = "icon";
        img.width = 32;
        img.height = 32;
        img.alt = "";
        img.loading = "lazy";
        img.src = iconSrc(item);
        img.addEventListener("error", function once() {
            img.removeEventListener("error", once);
            img.src = ICON_FALLBACK;
        });
        tdIco.appendChild(img);
        tr.appendChild(tdIco);

        // 이름 + 그룹
        var tdName = document.createElement("td");
        tdName.className = "tbl__item";
        var name = document.createElement("span");
        name.className = "name";
        name.textContent = item.name;
        var group = document.createElement("span");
        group.className = "group";
        group.textContent = item.group || "";
        tdName.appendChild(name);
        tdName.appendChild(group);
        tr.appendChild(tdName);

        // 추이
        var tdSpark = document.createElement("td");
        tdSpark.className = "tbl__spark";
        tdSpark.appendChild(buildSpark(item));
        tr.appendChild(tdSpark);

        // 충족률
        var tdBar = document.createElement("td");
        tdBar.className = "tbl__bar";
        tdBar.appendChild(buildBar(item, index));
        tr.appendChild(tdBar);

        // 보유 / 목표 (목표는 인라인 편집)
        var tdQty = document.createElement("td");
        tdQty.className = "tbl__n tbl__qty";
        var stocked = document.createElement("span");
        stocked.className = "qty__a";
        stocked.textContent = num(item.stocked);
        tdQty.appendChild(stocked);
        var slash = document.createElement("span");
        slash.className = "qty__slash";
        slash.textContent = "/";
        tdQty.appendChild(slash);
        var input = document.createElement("input");
        input.type = "number";
        input.min = "0";
        input.step = "1";
        input.className = "target";
        input.value = String(item.target);
        input.setAttribute("aria-label", item.name + " 목표 수량");
        input.addEventListener("change", function () {
            var next = parseInt(input.value, 10);
            item.target = isNaN(next) || next < 0 ? 0 : next;
            render();
        });
        tdQty.appendChild(input);
        tr.appendChild(tdQty);

        // 부족
        var tdShort = document.createElement("td");
        tdShort.className = "tbl__n tbl__short " + (short ? "short" : "ok");
        tdShort.textContent = short ? "−" + num(short) : "충족";
        tr.appendChild(tdShort);

        // 예상 비용 + 단가
        var tdIsk = document.createElement("td");
        tdIsk.className = "tbl__n tbl__isk";
        var total = document.createElement("span");
        total.className = "isk";
        total.textContent = short ? isk(lineCost(item)) : "—";
        var unit = document.createElement("span");
        unit.className = "isk__unit";
        unit.textContent = unitPrice(item) ? isk(unitPrice(item)) + " /개" : "";
        tdIsk.appendChild(total);
        tdIsk.appendChild(unit);
        tr.appendChild(tdIsk);

        return tr;
    }

    /* ── 렌더: 매니페스트 ───────────────────────────────── */

    function manifestItems() {
        return state.items.filter(included);
    }

    function manifestText() {
        // EVE 멀티바이는 "품목명<TAB>수량" 줄을 읽는다. 이름은 인게임 표기와 정확히 일치해야 한다.
        return manifestItems()
            .map(function (item) {
                return item.name + "\t" + deficit(item);
            })
            .join("\n");
    }

    function renderManifest() {
        var picked = manifestItems();

        el.slab.textContent = "";
        picked.forEach(function (item) {
            var row = document.createElement("div");
            row.className = "slab__row";

            var name = document.createElement("span");
            name.className = "slab__name";
            name.textContent = item.name;

            var qty = document.createElement("span");
            qty.className = "slab__qty";
            qty.textContent = num(deficit(item));

            row.appendChild(name);
            row.appendChild(qty);
            el.slab.appendChild(row);
        });

        var vol = picked.reduce(function (sum, item) {
            return sum + deficit(item) * (item.unitVolume || 0);
        }, 0);
        var cost = picked.reduce(function (sum, item) {
            return sum + lineCost(item);
        }, 0);

        el.manifestLines.textContent = num(picked.length);
        el.manifestVolume.textContent = volume(vol);
        el.manifestIsk.textContent = cost > 0 ? iskTotal(cost) : "—";
        el.copy.disabled = picked.length === 0;
    }

    /* ── 렌더 ───────────────────────────────────────────── */

    function render() {
        var items = visibleItems();

        el.priceSource.textContent = state.priceSource;

        el.rows.textContent = "";
        items.forEach(function (item, i) {
            el.rows.appendChild(buildRow(item, i));
        });

        if (items.length === 0) {
            el.empty.hidden = false;
            el.empty.textContent = state.query.trim()
                ? "검색과 맞는 품목이 없습니다."
                : state.filter === "short"
                  ? "모든 품목이 목표 재고를 채웠습니다."
                  : "표시할 품목이 없습니다.";
        } else {
            el.empty.hidden = true;
        }

        renderManifest();
        state.firstPaint = false;
    }

    /* ── 토스트 ─────────────────────────────────────────── */

    var toastTimer = null;

    function toast(message, tone) {
        el.toast.textContent = message;
        if (tone) el.toast.setAttribute("data-tone", tone);
        else el.toast.removeAttribute("data-tone");
        el.toast.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            el.toast.hidden = true;
        }, 2600);
    }

    /* ── 복사 ───────────────────────────────────────────── */

    function copyManifest() {
        var text = manifestText();
        if (!text) return;

        function fallback() {
            // 클립보드 API는 보안 컨텍스트(https / localhost)에서만 동작한다.
            var range = document.createRange();
            range.selectNodeContents(el.slab);
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            el.slab.focus();
            toast("매니페스트를 선택했습니다. Ctrl+C 로 복사하세요.", "warn");
        }

        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(function () {
                toast("매니페스트를 복사했습니다.");
            }, fallback);
        } else {
            fallback();
        }
    }

    /* ── 이벤트 ─────────────────────────────────────────── */

    document.querySelectorAll("[data-filter]").forEach(function (btn) {
        btn.addEventListener("click", function () {
            state.filter = btn.getAttribute("data-filter");
            document.querySelectorAll("[data-filter]").forEach(function (b) {
                b.classList.toggle("is-on", b === btn);
                b.setAttribute("aria-pressed", String(b === btn));
            });
            render();
        });
    });

    el.query.addEventListener("input", function () {
        state.query = el.query.value;
        render();
    });

    el.copy.addEventListener("click", copyManifest);

    /* ── 시작 ───────────────────────────────────────────── */

    state.items = loadItems();
    render();
    loadPrices();
})();
