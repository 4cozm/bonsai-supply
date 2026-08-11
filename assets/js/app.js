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
        included: new Set(), // 기본은 "전부 미포함", 사용자가 고른 것만 기록한다
        unitPrices: {},
        priceSource: "—",
        baseTarget: {}, // 저장 전 원래 목표 수량. 키가 있으면 곧 "변경됨"이다.
        sort: { key: "days", asc: true },
        sampledAt: Date.now(),
        sampleMs: 10 * 60 * 1000,
        sparkPoints: 144, // 표의 스파크라인이 그리는 표본 수 (24시간 / 10분)
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
        pending: document.querySelector("[data-pending]"),
        pendingCount: document.querySelector("[data-pending-count]"),
        sort: document.querySelector("[data-sort]"),
        sortDir: document.querySelector("[data-sort-dir]"),
        sortDirLabel: document.querySelector("[data-sort-dir-label]"),
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
        return isShort(item) && state.included.has(item.name);
    }

    function ratioOf(item) {
        return item.target > 0 ? item.stocked / item.target : 1;
    }

    /**
     * 최근 소비 속도(개/일).
     *
     * 감소분만 더한다 — 보급이 들어온 계단은 소비가 아니므로 빼고 세야 실제 소진 속도가 나온다.
     * 창은 7일. 더 짧으면 전투 한 번에 출렁이고, 더 길면 최근 변화를 못 따라간다.
     */
    function burnRate(item) {
        var h = item.history || [];
        if (h.length < 2) return 0;
        var perDay = (24 * 60 * 60 * 1000) / state.sampleMs;
        var from = Math.max(0, h.length - Math.round(perDay * 7));
        var drop = 0;
        for (var i = from + 1; i < h.length; i++) {
            if (h[i] < h[i - 1]) drop += h[i - 1] - h[i];
        }
        var days = (h.length - 1 - from) / perDay;
        return days > 0 ? drop / days : 0;
    }

    /** 이 속도면 며칠 뒤 바닥나는가. 소비가 없으면 Infinity. */
    function daysLeft(item) {
        var rate = burnRate(item);
        if (rate <= 0) return Infinity;
        return item.stocked / rate;
    }

    /** 부피당 가치 — 한 번에 다 못 실을 때 무엇을 먼저 싣느냐를 가른다. */
    function iskPerM3(item) {
        var v = item.unitVolume || 0;
        if (!v) return 0;
        return unitPrice(item) / v;
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
        if (mock.sampleMinutes) {
            state.sampleMs = mock.sampleMinutes * 60 * 1000;
            if (el.sampleMinutes) el.sampleMinutes.textContent = String(mock.sampleMinutes);
        }
        if (mock.sparkHours) {
            state.sparkPoints = Math.round((mock.sparkHours * 60) / (mock.sampleMinutes || 10));
            if (el.historyWindow) el.historyWindow.textContent = String(mock.sparkHours);
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

    /* ── 정렬 ───────────────────────────────────────────── */

    /**
     * 축마다 값과 방향 표기가 다르다. "적은 순"이 급한 것도 있고(소진 예상일)
     * 그렇지 않은 것도 있어서(예상 비용) 라벨을 축에 붙여 둔다.
     */
    var SORT = {
        days: { value: daysLeft, asc: "급한 순", desc: "여유 순" },
        ratio: { value: ratioOf, asc: "많이 부족한 순", desc: "덜 부족한 순" },
        short: { value: deficit, desc: "많은 순", asc: "적은 순" },
        cost: { value: lineCost, desc: "비싼 순", asc: "싼 순" },
        volume: {
            value: function (i) {
                return deficit(i) * (i.unitVolume || 0);
            },
            desc: "큰 순",
            asc: "작은 순",
        },
        density: { value: iskPerM3, desc: "높은 순", asc: "낮은 순" },
        name: { value: null, asc: "가나다 순", desc: "역순" },
    };

    function sortItems(list) {
        var spec = SORT[state.sort.key] || SORT.days;
        var sign = state.sort.asc ? 1 : -1;

        return list.slice().sort(function (a, b) {
            if (!spec.value) return sign * a.name.localeCompare(b.name, "ko");
            var av = spec.value(a);
            var bv = spec.value(b);
            // Infinity(소비 없음)는 어느 방향이든 끝으로 보낸다 — 정렬의 목적이
            // 급한 것을 앞에 두는 것이지, 계산 불가한 항목을 앞세우는 게 아니다.
            if (!isFinite(av) && !isFinite(bv)) return 0;
            if (!isFinite(av)) return 1;
            if (!isFinite(bv)) return -1;
            return sign * (av - bv);
        });
    }

    function renderSortDir() {
        var spec = SORT[state.sort.key] || SORT.days;
        el.sortDirLabel.textContent = state.sort.asc ? spec.asc : spec.desc;
    }

    /* ── 표시 대상 ──────────────────────────────────────── */

    function visibleItems() {
        var q = state.query.trim().toLowerCase();
        var kept = state.items.filter(function (item) {
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
        return sortItems(kept);
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

        // 전체 히스토리는 모달용이고, 표의 스파크라인은 최근 구간만 보여 준다.
        var all = item.history || [];
        var from = Math.max(0, all.length - state.sparkPoints);
        var data = all.slice(from);
        if (data.length < 2) {
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

        attachSparkHover(svg, item, data, pts, from);

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

    /**
     * 전체 히스토리 기준 절대 인덱스 → 시각. 마지막 표본이 "지금"이다.
     * 구간을 잘라 그릴 때도 시각이 흔들리지 않도록 항상 전체 길이를 기준으로 센다.
     */
    function timeAt(absIndex, item) {
        var total = (item.history || []).length;
        return new Date(state.sampledAt - (total - 1 - absIndex) * state.sampleMs);
    }

    function showTip(clientX, rect, item, absIndex, value) {
        tip.textContent = "";
        tip.style.setProperty("--fill", rampColor(ratioOf(item)));

        var when = document.createElement("span");
        when.className = "tip__when";
        when.textContent = whenLabel(timeAt(absIndex, item));

        var qty = document.createElement("span");
        qty.className = "tip__qty";
        qty.textContent = "  " + num(value) + "개";

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

    function attachSparkHover(svg, item, data, pts, from) {
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

            showTip(e.clientX, rect, item, from + i, data[i]);
        });

        svg.addEventListener("pointerleave", function () {
            guide.style.display = "none";
            hit.style.display = "none";
            hideTip();
        });
    }

    /* ── 목표 수량 변경 추적 ────────────────────────────── */

    /**
     * 편집한 값은 화면에 바로 반영하되, 원래 값을 따로 들고 있는다.
     * 부족분·매니페스트가 즉시 갱신되어야 계획을 세울 수 있고, 동시에
     * "이건 아직 서버에 없는 값"이라는 것도 드러나야 하기 때문이다.
     */
    function setTarget(item, next) {
        if (!(item.name in state.baseTarget)) state.baseTarget[item.name] = item.target;
        item.target = next;
        // 원래 값으로 되돌아왔으면 변경이 아니다.
        if (state.baseTarget[item.name] === next) delete state.baseTarget[item.name];
    }

    function isDirty(item) {
        return item.name in state.baseTarget;
    }

    function pendingChanges() {
        return state.items
            .filter(isDirty)
            .map(function (item) {
                return { item: item, from: state.baseTarget[item.name], to: item.target };
            });
    }

    function renderPending() {
        var changes = pendingChanges();
        el.pending.hidden = changes.length === 0;
        el.pendingCount.textContent = num(changes.length);
    }

    function resetTargets() {
        state.items.forEach(function (item) {
            if (isDirty(item)) item.target = state.baseTarget[item.name];
        });
        state.baseTarget = {};
        render();
        toast("변경을 되돌렸습니다.");
    }

    /* ── 선택 제스처: 클릭 = 상세, 드래그 = 다중 선택 ───── */

    var DRAG_THRESHOLD = 5; // px. 이 아래면 손떨림으로 보고 클릭으로 친다.
    var drag = null;

    function rowFor(item) {
        var rows = el.rows.children;
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].__item === item) return rows[i];
        }
        return null;
    }

    /**
     * 포함 여부를 바꾸고 **해당 행만** 갱신한다.
     * 드래그 중에 전체 재렌더를 돌리면 커서 아래 DOM이 매 틱 교체되어
     * elementFromPoint 가 헛짚고 깜빡임도 생긴다.
     * @returns {boolean} 실제로 바뀌었으면 true
     */
    function applyInclusion(item, on) {
        if (!isShort(item)) return false;
        if (included(item) === on) return false;

        if (on) state.included.add(item.name);
        else state.included.delete(item.name);

        var tr = rowFor(item);
        if (tr) {
            var box = tr.querySelector(".pick");
            if (box) box.checked = on;
        }
        return true;
    }

    function endDrag(open) {
        if (!drag) return;
        var started = drag;
        drag = null;
        window.removeEventListener("pointermove", onDragMove);
        window.removeEventListener("pointerup", onDragUp);
        window.removeEventListener("pointercancel", onDragCancel);
        document.body.classList.remove("is-dragging");

        if (started.moved) {
            // 포인터가 누른 요소를 벗어나지 않았다면 브라우저가 click 을 마저 쏜다.
            // 체크박스라면 방금 드래그로 정한 값을 되돌리고, 이름이라면 모달을 연다.
            // 그 click 은 pointerup 직후 같은 태스크에서 오므로, 다음 태스크에 플래그를 턴다.
            // 벗어난 경우엔 click 이 아예 오지 않는데, 그때 플래그가 남으면
            // 이후의 멀쩡한 클릭(키보드 포함)이 먹힌다.
            suppressNextClick = true;
            setTimeout(function () {
                suppressNextClick = false;
            }, 0);
            return;
        }
        // 움직이지 않았다 = 클릭. 체크박스와 이름 버튼은 자기 핸들러가 처리하므로 비켜 준다.
        if (open && !started.fromPick && !started.fromName) openDetail(started.item);
    }

    var suppressNextClick = false;
    el.rows.addEventListener(
        "click",
        function (e) {
            if (!suppressNextClick) return;
            suppressNextClick = false;
            e.preventDefault();
            e.stopPropagation();
        },
        true // 캡처 단계 — 체크박스/버튼의 핸들러보다 먼저 잡아야 한다
    );

    function onDragMove(e) {
        if (!drag) return;

        if (!drag.moved) {
            if (
                Math.abs(e.clientX - drag.x) < DRAG_THRESHOLD &&
                Math.abs(e.clientY - drag.y) < DRAG_THRESHOLD
            ) {
                return;
            }
            drag.moved = true;
            document.body.classList.add("is-dragging");
            // 시작한 행의 토글은 여기까지 미뤄 뒀다 — 눌렀다 뗀 것뿐이면 클릭(상세)이어야 하므로.
            // 드래그로 확정된 지금 되짚어 반영한다.
            if (drag.mode !== null && applyInclusion(drag.item, drag.mode)) renderManifest();
        }

        var under = document.elementFromPoint(e.clientX, e.clientY);
        var tr = under && under.closest ? under.closest("tr.row") : null;
        if (!tr || !tr.__item) return;

        var item = tr.__item;
        if (!isShort(item)) return; // 충족 품목은 매니페스트에 들어갈 수 없다

        // 처음 닿은 부족 품목이 모드를 정한다 — RimWorld 와 같은 규칙.
        if (drag.mode === null) drag.mode = !included(item);
        if (applyInclusion(item, drag.mode)) renderManifest();
    }

    function onDragUp() {
        endDrag(true);
    }

    function onDragCancel() {
        endDrag(false);
    }

    el.rows.addEventListener("pointerdown", function (e) {
        if (e.button !== 0) return;
        // 터치는 세로 드래그가 스크롤이다. 뺏으면 목록을 못 넘긴다.
        if (e.pointerType === "touch") return;

        // 직전 드래그에서 세워 둔 억제 플래그를 여기서 턴다. 포인터가 누른 요소를 벗어나면
        // click 이 아예 오지 않아 플래그가 남고, 그러면 다음 정상 클릭이 먹힌다.
        suppressNextClick = false;

        var tr = e.target.closest ? e.target.closest("tr.row") : null;
        if (!tr || !tr.__item) return;
        // 목표 수량 입력만 제외한다. 여기서 끄는 건 숫자 선택이지 행 선택이 아니다.
        if (e.target.closest(".target")) return;

        var item = tr.__item;
        drag = {
            x: e.clientX,
            y: e.clientY,
            moved: false,
            item: item,
            mode: isShort(item) ? !included(item) : null,
            // 이 둘은 자기 클릭 동작이 따로 있다. 드래그가 아니었다면 그쪽에 맡긴다.
            fromPick: !!e.target.closest(".pick"),
            fromName: !!e.target.closest("button.name"),
        };
        window.addEventListener("pointermove", onDragMove);
        window.addEventListener("pointerup", onDragUp);
        window.addEventListener("pointercancel", onDragCancel);
    });

    /* ── 상세 모달: 전체 추이 그래프 ────────────────────── */

    var modal = {
        root: document.querySelector("[data-modal]"),
        icon: document.querySelector("[data-modal-icon]"),
        name: document.querySelector("[data-modal-name]"),
        group: document.querySelector("[data-modal-group]"),
        stocked: document.querySelector("[data-modal-stocked]"),
        target: document.querySelector("[data-modal-target]"),
        short: document.querySelector("[data-modal-short]"),
        delta: document.querySelector("[data-modal-delta]"),
        chart: document.querySelector("[data-modal-chart]"),
        cap: document.querySelector("[data-modal-cap]"),
        close: document.querySelector("[data-modal-close]"),
        presets: [].slice.call(document.querySelectorAll("[data-range]")),
        dateFrom: document.querySelector("[data-range-from]"),
        dateTo: document.querySelector("[data-range-to]"),
    };
    modal.deltaLabel = modal.delta.previousElementSibling; // "24시간 변화" dt

    var CHART_H = 240;
    var PAD = { top: 14, right: 12, bottom: 24, left: 46 };
    var DAY_MS = 24 * 60 * 60 * 1000;

    function svgEl(tag, attrs) {
        var e = document.createElementNS("http://www.w3.org/2000/svg", tag);
        for (var k in attrs) e.setAttribute(k, String(attrs[k]));
        return e;
    }

    /* ── 기간 선택 ──────────────────────────────────────── */

    var range = { preset: "7", from: 0, to: 0 };

    function totalPoints(item) {
        return (item.history || []).length;
    }

    /** 프리셋(일수 또는 "all") → 절대 인덱스 구간 */
    function presetRange(item, preset) {
        var total = totalPoints(item);
        if (preset === "all") return { from: 0, to: total - 1 };
        var pts = Math.round((Number(preset) * DAY_MS) / state.sampleMs);
        return { from: Math.max(0, total - pts), to: total - 1 };
    }

    /**
     * 시각 → 절대 인덱스. 반올림하면 고른 날짜 밖의 표본을 집는다 —
     * 6/15 까지 골랐는데 캡션이 6/16 00:00 으로 뜨는 식이다.
     * @param {Function} round Math.floor(시작: 그 시각 이후 첫 표본) 또는 Math.ceil(종료: 그 시각 이전 마지막 표본)
     */
    function indexForTime(ms, item, round) {
        var total = totalPoints(item);
        var idx = total - 1 - (round || Math.round)((state.sampledAt - ms) / state.sampleMs);
        return Math.max(0, Math.min(total - 1, idx));
    }

    function dateInputValue(d) {
        var p = function (n) {
            return (n < 10 ? "0" : "") + n;
        };
        return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
    }

    /**
     * 화면 폭보다 표본이 많으면 그대로 그릴 이유가 없다. 90일이면 12,960점인데
     * 700px 짜리 그래프에 다 밀어 넣으면 한 픽셀에 열여덟 점이 겹친다.
     * 절대 인덱스를 함께 들고 다녀야 hover 시각이 맞는다.
     */
    function sampleRange(item, from, to, maxPoints) {
        var h = item.history;
        var n = to - from + 1;
        var stride = Math.max(1, Math.ceil(n / maxPoints));
        var out = [];
        for (var i = from; i <= to; i += stride) out.push({ abs: i, v: h[i] });
        if (!out.length || out[out.length - 1].abs !== to) out.push({ abs: to, v: h[to] });
        return out;
    }

    /**
     * 큰 추이 차트. 스파크라인과 달리 축과 목표선을 함께 그린다 —
     * "얼마나 남았나"가 아니라 "목표선 아래로 언제 내려갔나"를 읽는 그림이다.
     */
    function buildChart(item, CHART_W) {
        var wrap = document.createElement("div");
        if (totalPoints(item) < 2 || range.to - range.from < 1) {
            wrap.className = "empty";
            wrap.textContent = "선택한 기간에 기록이 없습니다.";
            return wrap;
        }

        // 한 픽셀에 한 점이면 충분하다. 90일 12,960점을 다 그릴 이유가 없다.
        var samples = sampleRange(item, range.from, range.to, Math.max(120, Math.round(CHART_W)));
        var data = samples.map(function (s) {
            return s.v;
        });

        var color = rampColor(ratioOf(item));
        // viewBox 폭을 실제 렌더 폭에 맞춘다. 고정 폭 viewBox를 늘려 쓰면 축 라벨 텍스트가
        // 가로로 찌그러진다 — 텍스트가 없는 스파크라인과 달리 여기서는 바로 티가 난다.
        var svg = svgEl("svg", {
            class: "chart__svg",
            viewBox: "0 0 " + CHART_W + " " + CHART_H,
            role: "img",
            "aria-label":
                item.name +
                " 최근 추이, " +
                num(data[0]) +
                "에서 " +
                num(data[data.length - 1]) +
                "로 변화",
        });
        svg.style.setProperty("--fill", color);

        // 목표가 곡선 밖에 있어도 점선이 보이도록 스케일에 포함시킨다.
        var lo = Math.min.apply(null, data);
        var hi = Math.max.apply(null, data.concat([item.target]));
        var span = hi - lo || 1;
        var plotW = CHART_W - PAD.left - PAD.right;
        var plotH = CHART_H - PAD.top - PAD.bottom;

        var xAt = function (i) {
            return PAD.left + (i / (data.length - 1)) * plotW;
        };
        var yAt = function (v) {
            return PAD.top + (1 - (v - lo) / span) * plotH;
        };

        // 가로 눈금 3줄 + 값 라벨
        [0, 0.5, 1].forEach(function (f) {
            var v = lo + span * f;
            var y = yAt(v);
            svg.appendChild(
                svgEl("line", { class: "chart__grid", x1: PAD.left, x2: CHART_W - PAD.right, y1: y, y2: y })
            );
            var t = svgEl("text", { class: "chart__label", x: PAD.left - 8, y: y + 3, "text-anchor": "end" });
            t.textContent = num(v);
            svg.appendChild(t);
        });

        var pts = data.map(function (v, i) {
            return [xAt(i), yAt(v)];
        });
        var line = pts
            .map(function (p) {
                return p[0].toFixed(1) + "," + p[1].toFixed(1);
            })
            .join(" ");

        svg.appendChild(
            svgEl("polygon", {
                class: "chart__area",
                points: PAD.left + "," + (CHART_H - PAD.bottom) + " " + line + " " + (CHART_W - PAD.right) + "," + (CHART_H - PAD.bottom),
            })
        );
        svg.appendChild(svgEl("polyline", { class: "chart__line", "vector-effect": "non-scaling-stroke", points: line }));

        // 목표선
        if (item.target > 0) {
            var ty = yAt(item.target);
            svg.appendChild(
                svgEl("line", { class: "chart__target", x1: PAD.left, x2: CHART_W - PAD.right, y1: ty, y2: ty })
            );
            var tl = svgEl("text", { class: "chart__label chart__label--target", x: CHART_W - PAD.right, y: ty - 5, "text-anchor": "end" });
            tl.textContent = "목표 " + num(item.target);
            svg.appendChild(tl);
        }

        // 시간 눈금 4개. 구간이 이틀을 넘으면 시:분은 노이즈라 날짜만 남긴다.
        var spanMs = (range.to - range.from) * state.sampleMs;
        [0, 0.33, 0.66, 1].forEach(function (f) {
            var i = Math.round(f * (data.length - 1));
            var d = timeAt(samples[i].abs, item);
            var t = svgEl("text", {
                class: "chart__label",
                x: xAt(i),
                y: CHART_H - PAD.bottom + 15,
                "text-anchor": f === 0 ? "start" : f === 1 ? "end" : "middle",
            });
            t.textContent = spanMs > 2 * DAY_MS ? d.getMonth() + 1 + "/" + d.getDate() : whenLabel(d);
            svg.appendChild(t);
        });

        var guide = svgEl("line", { class: "chart__guide", y1: PAD.top, y2: CHART_H - PAD.bottom });
        guide.style.display = "none";
        svg.appendChild(guide);
        var dot = svgEl("circle", { class: "chart__dot", r: 3 });
        dot.style.display = "none";
        svg.appendChild(dot);

        svg.addEventListener("pointermove", function (e) {
            var rect = svg.getBoundingClientRect();
            if (!rect.width) return;
            // viewBox 좌표로 환산해야 축 여백이 있어도 인덱스가 맞는다.
            var vx = ((e.clientX - rect.left) / rect.width) * CHART_W;
            var k = Math.max(0, Math.min(1, (vx - PAD.left) / plotW));
            var i = Math.round(k * (data.length - 1));
            guide.setAttribute("x1", pts[i][0]);
            guide.setAttribute("x2", pts[i][0]);
            guide.style.display = "";
            dot.setAttribute("cx", pts[i][0]);
            dot.setAttribute("cy", pts[i][1]);
            dot.style.display = "";
            showTip(e.clientX, rect, item, samples[i].abs, data[i]);
        });
        svg.addEventListener("pointerleave", function () {
            guide.style.display = "none";
            dot.style.display = "none";
            hideTip();
        });

        wrap.appendChild(svg);
        return wrap;
    }

    function openDetail(item) {
        var short = deficit(item);

        modal.icon.src = iconSrc(item);
        modal.icon.onerror = function () {
            modal.icon.onerror = null;
            modal.icon.src = ICON_FALLBACK;
        };
        modal.name.textContent = item.name;
        modal.group.textContent = item.group || "";
        modal.stocked.textContent = num(item.stocked);
        modal.target.textContent = num(item.target);
        modal.short.textContent = short ? "−" + num(short) : "충족";
        modal.short.className = "stat__v " + (short ? "short" : "ok");

        // 모달을 열 때마다 기본 구간으로 되돌린다 — 직전 품목에서 좁혀 둔 범위가
        // 다음 품목에 따라붙으면 무엇을 보고 있는지 헷갈린다.
        setPreset(item, "7");

        // 차트는 모달을 연 뒤에 그린다 — 닫힌 dialog 는 폭이 0이라 viewBox 를 맞출 수 없다.
        modal.root.showModal();
        drawChart(item);
    }

    var openItem = null;

    function drawChart(item) {
        openItem = item;
        var w = Math.round(modal.chart.clientWidth) || 700;
        modal.chart.textContent = "";
        modal.chart.appendChild(buildChart(item, w));

        // 구간 안에서의 변화량 — 상단 통계는 "지금 보고 있는 기간" 기준이어야 한다.
        var h = item.history || [];
        var change = h.length > 1 ? h[range.to] - h[range.from] : 0;
        modal.delta.textContent = (change > 0 ? "+" : change < 0 ? "−" : "") + num(Math.abs(change));
        modal.delta.style.color = change < 0 ? "var(--amber)" : change > 0 ? "var(--high)" : "";

        var days = Math.max(1, Math.round(((range.to - range.from) * state.sampleMs) / DAY_MS));
        modal.deltaLabel.textContent = days + "일 변화";
        modal.cap.textContent =
            whenLabel(timeAt(range.from, item)) +
            " – " +
            whenLabel(timeAt(range.to, item)) +
            " · 10분 간격 · 점선은 목표 수량";
    }

    /** 프리셋 버튼 상태와 날짜 입력을 함께 맞춘다 — 지금 보는 구간이 날짜로도 읽혀야 한다. */
    function setPreset(item, preset) {
        range.preset = preset;
        var r = presetRange(item, preset);
        range.from = r.from;
        range.to = r.to;
        syncRangeControls(item);
    }

    function syncRangeControls(item) {
        modal.presets.forEach(function (b) {
            var on = b.getAttribute("data-range") === range.preset;
            b.classList.toggle("is-on", on);
            b.setAttribute("aria-pressed", String(on));
        });
        var lo = timeAt(0, item);
        var hi = timeAt(totalPoints(item) - 1, item);
        modal.dateFrom.min = modal.dateTo.min = dateInputValue(lo);
        modal.dateFrom.max = modal.dateTo.max = dateInputValue(hi);
        modal.dateFrom.value = dateInputValue(timeAt(range.from, item));
        modal.dateTo.value = dateInputValue(timeAt(range.to, item));
    }

    function applyDateRange() {
        if (!openItem) return;
        var a = modal.dateFrom.value ? new Date(modal.dateFrom.value + "T00:00:00") : null;
        var b = modal.dateTo.value ? new Date(modal.dateTo.value + "T23:59:59") : null;
        if (!a || !b || isNaN(a) || isNaN(b)) return;

        var from = indexForTime(a.getTime(), openItem, Math.floor);
        var to = indexForTime(b.getTime(), openItem, Math.ceil);
        if (to <= from) return; // 뒤집힌 범위는 무시한다 — 조용히 고쳐 놓으면 더 헷갈린다

        range.from = from;
        range.to = to;
        range.preset = null; // 직접 고른 구간이므로 어떤 프리셋도 켜지 않는다
        modal.presets.forEach(function (btn) {
            btn.classList.remove("is-on");
            btn.setAttribute("aria-pressed", "false");
        });
        drawChart(openItem);
    }

    modal.presets.forEach(function (btn) {
        btn.addEventListener("click", function () {
            if (!openItem) return;
            setPreset(openItem, btn.getAttribute("data-range"));
            drawChart(openItem);
        });
    });
    modal.dateFrom.addEventListener("change", applyDateRange);
    modal.dateTo.addEventListener("change", applyDateRange);

    // 창 크기가 바뀌면 viewBox 폭이 어긋나므로 다시 그린다.
    window.addEventListener("resize", function () {
        if (modal.root.open && openItem) drawChart(openItem);
    });

    modal.close.addEventListener("click", function () {
        modal.root.close();
    });
    // 백드롭 클릭으로 닫기 — dialog 자신이 이벤트 타깃이면 바깥을 누른 것이다.
    modal.root.addEventListener("click", function (e) {
        if (e.target === modal.root) modal.root.close();
    });
    modal.root.addEventListener("close", hideTip);

    /* ── 렌더: 행 ───────────────────────────────────────── */

    function buildRow(item, index) {
        var short = deficit(item);
        var tr = document.createElement("tr");
        tr.className = "row";
        tr.__item = item; // 포인터 제스처가 행 → 품목을 되짚을 때 쓴다

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
                applyInclusion(item, box.checked);
                renderManifest();
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
        var name = document.createElement("button");
        name.type = "button";
        name.className = "name";
        name.textContent = item.name;
        name.addEventListener("click", function () {
            openDetail(item);
        });
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
        if (isDirty(item)) input.classList.add("is-dirty");
        input.addEventListener("change", function () {
            var next = parseInt(input.value, 10);
            setTarget(item, isNaN(next) || next < 0 ? 0 : next);
            render();
        });
        tdQty.appendChild(input);
        tr.appendChild(tdQty);

        // 부족
        var tdShort = document.createElement("td");
        tdShort.className = "tbl__n tbl__short " + (short ? "short" : "ok");
        var shortMain = document.createElement("span");
        shortMain.textContent = short ? "−" + num(short) : "충족";
        tdShort.appendChild(shortMain);
        var left = daysLeft(item);
        if (isFinite(left)) {
            var runOut = document.createElement("span");
            runOut.className = "runout" + (left <= 3 ? " is-soon" : "");
            runOut.textContent = (left < 10 ? Math.round(left * 10) / 10 : Math.round(left)) + "일 남음";
            tdShort.appendChild(runOut);
        }
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
        renderPending();
        state.firstPaint = false;
    }

    /* ── 저장 확인 모달 ─────────────────────────────────── */

    var saveModal = {
        root: document.querySelector("[data-save-modal]"),
        list: document.querySelector("[data-save-list]"),
        confirm: document.querySelector("[data-save-confirm]"),
    };

    function openSaveModal() {
        var changes = pendingChanges();
        if (!changes.length) return;

        saveModal.list.textContent = "";
        changes.forEach(function (c) {
            var li = document.createElement("li");
            li.className = "diff__row";

            var name = document.createElement("span");
            name.className = "diff__name";
            name.textContent = c.item.name;

            var change = document.createElement("span");
            change.className = "diff__change";
            var from = document.createElement("span");
            from.className = "diff__from";
            from.textContent = num(c.from) + "개";
            var to = document.createElement("span");
            to.className = "diff__to";
            to.textContent = num(c.to) + "개";
            change.appendChild(from);
            change.appendChild(document.createTextNode(" → "));
            change.appendChild(to);

            li.appendChild(name);
            li.appendChild(change);
            saveModal.list.appendChild(li);
        });

        saveModal.root.showModal();
    }

    function commitTargets() {
        var changes = pendingChanges();
        // TODO: 백엔드 연결 시 여기서 PATCH /api/targets 를 보낸다.
        // 지금은 성공했다고 가정하고 로컬 상태만 확정한다.
        state.baseTarget = {};
        saveModal.root.close();
        render();
        toast(num(changes.length) + "건을 저장했습니다.");
    }

    /* ── 품목 추가 모달 ─────────────────────────────────── */

    var addModal = {
        root: document.querySelector("[data-add-modal]"),
        text: document.querySelector("[data-add-text]"),
        check: document.querySelector("[data-add-check]"),
        status: document.querySelector("[data-add-status]"),
        list: document.querySelector("[data-add-list]"),
        confirm: document.querySelector("[data-add-confirm]"),
    };

    // 확인 결과. { typeId, name, language, qty } 또는 { name, missing: true }
    var addRows = [];

    function setAddStatus(text, tone) {
        addModal.status.hidden = !text;
        addModal.status.textContent = text || "";
        if (tone) addModal.status.setAttribute("data-tone", tone);
        else addModal.status.removeAttribute("data-tone");
    }

    function renderAddRows() {
        addModal.list.textContent = "";

        addRows.forEach(function (row, index) {
            var li = document.createElement("li");
            li.className = "add__row" + (row.missing ? " is-missing" : "");

            if (row.missing) {
                var mark = document.createElement("span");
                mark.className = "add__icon";
                li.appendChild(mark);
            } else {
                var img = document.createElement("img");
                img.className = "add__icon";
                img.width = 28;
                img.height = 28;
                img.alt = "";
                img.src = ICON_BASE + row.typeId + "/icon?size=64";
                img.addEventListener("error", function once() {
                    img.removeEventListener("error", once);
                    img.src = ICON_FALLBACK;
                });
                li.appendChild(img);
            }

            var name = document.createElement("span");
            name.className = "add__name";
            name.textContent = row.name;
            var meta = document.createElement("span");
            meta.className = "add__meta";
            meta.textContent = row.missing
                ? "이브에서 찾을 수 없는 이름입니다"
                : "#" + row.typeId + " · " + (row.language === "ko" ? "한글" : "영문");
            name.appendChild(meta);
            li.appendChild(name);

            if (!row.missing) {
                var qty = document.createElement("input");
                qty.type = "number";
                qty.min = "0";
                qty.className = "add__qty";
                qty.value = String(row.qty);
                qty.setAttribute("aria-label", row.name + " 목표 수량");
                qty.addEventListener("change", function () {
                    var v = parseInt(qty.value, 10);
                    row.qty = isNaN(v) || v < 0 ? 0 : v;
                });
                li.appendChild(qty);
            }

            var drop = document.createElement("button");
            drop.type = "button";
            drop.className = "add__drop";
            drop.textContent = "✕";
            drop.setAttribute("aria-label", row.name + " 목록에서 빼기");
            drop.addEventListener("click", function () {
                addRows.splice(index, 1);
                renderAddRows();
            });
            li.appendChild(drop);

            addModal.list.appendChild(li);
        });

        var missing = addRows.filter(function (r) {
            return r.missing;
        }).length;
        var ok = addRows.length - missing;

        // 찾을 수 없는 이름이 하나라도 남아 있으면 저장을 막는다. 백엔드에 쓰레기를
        // 보내는 것보다, 여기서 사용자가 오타를 고치거나 빼는 편이 낫다.
        addModal.confirm.disabled = ok === 0 || missing > 0;

        if (missing) {
            setAddStatus(
                missing + "개를 찾을 수 없습니다. 이름을 고치거나 목록에서 빼야 추가할 수 있습니다.",
                "warn"
            );
        } else if (ok) {
            setAddStatus(ok + "개를 확인했습니다.");
        } else {
            setAddStatus("");
        }
    }

    function checkAddNames() {
        var parsed = window.BonsaiEsi.parseLines(addModal.text.value);
        if (!parsed.length) {
            addRows = [];
            renderAddRows();
            setAddStatus("추가할 품목을 입력하세요.", "warn");
            return;
        }

        // 이미 추적 중인 품목은 걸러낸다 — 목표 수량 변경은 표에서 하면 된다.
        var known = Object.create(null);
        state.items.forEach(function (i) {
            known[String(i.name).toLowerCase()] = true;
            if (i.typeId) known["#" + i.typeId] = true;
        });

        addModal.check.disabled = true;
        setAddStatus("이브에서 확인하는 중…");

        var names = parsed.map(function (p) {
            return p.name;
        });

        window.BonsaiEsi.resolveNames(names).then(
            function (res) {
                addRows = [];
                parsed.forEach(function (p) {
                    var hit = res.found[p.name.toLowerCase()];
                    if (!hit) {
                        addRows.push({ name: p.name, missing: true });
                        return;
                    }
                    if (known[hit.name.toLowerCase()] || known["#" + hit.id]) return; // 이미 추적 중
                    addRows.push({
                        typeId: hit.id,
                        name: hit.name,
                        language: hit.language,
                        qty: p.qty == null ? 0 : p.qty,
                    });
                });
                addModal.check.disabled = false;
                renderAddRows();
            },
            function (err) {
                addModal.check.disabled = false;
                setAddStatus("이브에 연결하지 못했습니다: " + (err && err.message), "warn");
            }
        );
    }

    function commitAdd() {
        var added = addRows.filter(function (r) {
            return !r.missing;
        });
        if (!added.length) return;

        // TODO: 백엔드 연결 시 POST /api/items. 지금은 로컬 목록에만 넣는다.
        added.forEach(function (r) {
            state.items.push({
                typeId: r.typeId,
                name: r.name,
                group: "",
                stocked: 0,
                target: r.qty,
                unitVolume: 0, // 실제 값은 백엔드가 ESI packaged_volume 으로 채운다
                history: [],
            });
        });

        addModal.root.close();
        addRows = [];
        addModal.text.value = "";
        renderAddRows();
        render();
        toast(num(added.length) + "개를 목록에 추가했습니다.");
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

    el.sort.addEventListener("change", function () {
        state.sort.key = el.sort.value;
        // 축을 바꾸면 그 축에서 "유용한 쪽"을 기본으로 잡는다. 소진 예상일과 부족률은
        // 급한 것이 앞에 와야 하고, 비용·부피·밀도는 큰 것이 앞에 와야 눈에 띈다.
        state.sort.asc = el.sort.value === "days" || el.sort.value === "ratio" || el.sort.value === "name";
        renderSortDir();
        render();
    });

    el.sortDir.addEventListener("click", function () {
        state.sort.asc = !state.sort.asc;
        renderSortDir();
        render();
    });

    el.copy.addEventListener("click", copyManifest);

    document.querySelector("[data-pending-save]").addEventListener("click", openSaveModal);
    document.querySelector("[data-pending-reset]").addEventListener("click", resetTargets);
    saveModal.confirm.addEventListener("click", commitTargets);
    document.querySelectorAll("[data-save-cancel]").forEach(function (b) {
        b.addEventListener("click", function () {
            saveModal.root.close();
        });
    });

    document.querySelector("[data-add-open]").addEventListener("click", function () {
        addRows = [];
        renderAddRows();
        setAddStatus("");
        addModal.root.showModal();
        addModal.text.focus();
    });
    addModal.check.addEventListener("click", checkAddNames);
    addModal.confirm.addEventListener("click", commitAdd);
    document.querySelectorAll("[data-add-cancel]").forEach(function (b) {
        b.addEventListener("click", function () {
            addModal.root.close();
        });
    });
    // 백드롭 클릭으로 닫기
    [saveModal.root, addModal.root].forEach(function (d) {
        d.addEventListener("click", function (e) {
            if (e.target === d) d.close();
        });
    });

    /* ── 시작 ───────────────────────────────────────────── */

    state.items = loadItems();
    renderSortDir();
    render();
    loadPrices();
})();
