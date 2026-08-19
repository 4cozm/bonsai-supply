/**
 * Bonsai Supply — 행어 재고 콘솔 (프론트 셸)
 *
 * 재고 데이터는 window.BonsaiApi(bonsai-bot-v2 REST API, 세션 쿠키 인증),
 * typeId→이름/그룹/부피 해석은 window.BonsaiEveTypes(공개 ESI 직접 호출),
 * 시세는 window.BonsaiPricing 에서 온다. 로그인은 폼이 아니라 Discord /보급
 * 명령이 발급하는 매직링크로만 하고, 세션이 없으면 인증 오버레이만 띄우고
 * 데이터 요청 자체를 안 한다(init() 참고).
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
        manifestQty: {}, // 매니페스트 수량 오버라이드. 없으면 부족분 전체가 기본이다.
        unitPrices: {},
        priceSource: "조회 중…",
        priceOk: true,
        priceApprox: false, // true 면 Fuzzwork 실시간 매도가가 아니라 ESI 평균값 폴백
        hub: null, // 4대 상권 station id. setupHub() 가 저장값/기본값(지타)으로 채운다.
        baseTarget: {}, // 저장 전 원래 목표 수량. 키가 있으면 곧 "변경됨"이다.
        sort: { key: "days", asc: true },
        sampledAt: Date.now(),
        // ESI 콥 자산 엔드포인트가 최대 1시간 캐시라(실측 확인됨), 동기화 크론도
        // 매시 정각으로 돈다 — 목업 시절 10분 가정은 실제 백엔드와 안 맞는다.
        sampleMs: 60 * 60 * 1000,
        sparkPoints: 24, // 표의 스파크라인이 그리는 표본 수 (GET /items의 recentHistory 길이와 맞춤)
        structureId: null, // fetchStructures() 결과의 첫 번째(또는 선택한) 구조물
        division: null, // 선택한 행어 번호(1-7). null이면 구조물 전체(필터 없음).
        container: null, // division 안 특정 컨테이너로 더 좁혔을 때만 값이 있다.
        firstPaint: true,
        // item.key(typeId+itemName) → { items:[{typeId,qty}], updatedAt } — 커스텀명
        // 있는 함선에 저장된 피팅. 구조물 로드 시 한 번만 받는다(loadFittings 참고).
        fittings: {},
        // 피팅 모듈 typeId → {name, group, unitVolume} — eveTypes.js resolveTypes
        // 결과 캐시. 모달/매니페스트에서 모듈 이름·부피를 보여주는 데 쓴다.
        fittingTypeInfo: {},
    };

    var el = {
        authgate: document.querySelector("[data-authgate]"),
        authgateMsg: document.querySelector("[data-authgate-msg]"),
        tablewrap: document.querySelector(".tablewrap"),
        rows: document.querySelector("[data-rows]"),
        empty: document.querySelector("[data-empty]"),
        manifestRows: document.querySelector("[data-manifest-rows]"),
        manifestEmpty: document.querySelector("[data-manifest-empty]"),
        copy: document.querySelector("[data-copy]"),
        toast: document.querySelector("[data-toast]"),
        toastText: document.querySelector("[data-toast-text]"),
        query: document.getElementById("q"),
        hangar: document.getElementById("hangar"),
        division: document.getElementById("division"),
        hub: document.querySelector("[data-hub]"),
        sync: document.querySelector("[data-sync]"),
        nextSync: document.querySelector("[data-next-sync]"),
        priceSource: document.querySelector("[data-price-source]"),
        priceNote: document.querySelector(".note"),
        historyWindow: document.querySelector("[data-history-window]"),
        sampleMinutes: document.querySelector("[data-sample-minutes]"),
        manifestLines: document.querySelector("[data-manifest-lines]"),
        manifestVolume: document.querySelector("[data-manifest-volume]"),
        manifestIsk: document.querySelector("[data-manifest-isk]"),
        pending: document.querySelector("[data-pending]"),
        pendingCount: document.querySelector("[data-pending-count]"),
        sortDir: document.querySelector("[data-sort-dir]"),
        sortDirLabel: document.querySelector("[data-sort-dir-label]"),
        langToggle: document.querySelector("[data-lang-toggle]"),
        langToggleLabel: document.querySelector("[data-lang-toggle-label]"),
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

    /**
     * 단가 줄(테이블 셀 안, 개당 가격)의 표기. state.priceApprox 면 물결표를 붙인다 —
     * 상단 캡션만 바꾸면 표만 보고 스크롤을 안 올리는 사람은 "실시간이 아니다"를
     * 놓친다. 숫자가 나오는 자리마다 표시해야 실제로 눈에 띈다.
     */
    function unitPriceLabel(n) {
        if (!n) return "";
        return (state.priceApprox ? "~" : "") + isk(n);
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

    var RAMP = {
        low: [224, 91, 79],
        mid: [232, 163, 61],
        high: [82, 183, 136],
        over: [63, 182, 196], // 100% 넘으면 점점 이쪽(--teal)으로 — 과잉 재고가 "더 좋다"가 아니라 "다른 상태"임을 색으로 구분
        none: [111, 130, 150], // 목표 없음 — --dim과 맞춘 중립색
    };

    /**
     * 충족률을 레드→앰버→그린→틸(파랑 계열) 사이에서 연속 보간한다. null(목표 없음)은
     * 중립색을 준다.
     * 0.5 지점이 앰버 — "절반이면 주의"가 색으로 읽힌다.
     *
     * 0~100% 두 구간 모두 선형 대신 이징을 쓴다. 선형으로 섞으면 20%짜리가 이미
     * 주황으로 보여서 정작 위험한 저재고가 덜 위험해 보인다. 아래쪽은 레드를 오래
     * 붙들고, 위쪽은 목표에 거의 닿아야 그린이 된다.
     *
     * 100% 넘는 구간은 200%에서 완전히 틸이 되도록 선형으로 잡는다 — 과잉은
     * "위험하지 않은 변화"라 급하게 이징할 이유가 없다.
     */
    function rampColor(ratio) {
        if (ratio == null) return "rgb(" + RAMP.none.join(",") + ")";

        var from, to, k;
        if (ratio > 1) {
            from = RAMP.high;
            to = RAMP.over;
            k = Math.max(0, Math.min(1, ratio - 1));
        } else {
            var t = Math.max(0, ratio);
            if (t < 0.5) {
                from = RAMP.low;
                to = RAMP.mid;
                k = Math.pow(t / 0.5, 1.8);
            } else {
                from = RAMP.mid;
                to = RAMP.high;
                k = Math.pow((t - 0.5) / 0.5, 1.3);
            }
        }
        var c = from.map(function (v, i) {
            return Math.round(v + (to[i] - v) * k);
        });
        return "rgb(" + c.join(",") + ")";
    }

    /* ── 파생값 ─────────────────────────────────────────── */

    // 목표를 0으로 고쳐 두면 "추적 안 함"으로 취급한다 — null(애초에 목표를 설정한 적
    // 없음)과 0(있었는데 이제 안 볼 거임)을 프론트에서는 굳이 구분하지 않는다.
    function hasNoTarget(item) {
        return item.target == null || item.target === 0;
    }

    function deficit(item) {
        if (hasNoTarget(item)) return 0;
        return Math.max(0, item.target - item.stocked);
    }

    function isShort(item) {
        return !hasNoTarget(item) && deficit(item) > 0;
    }

    function included(item) {
        return isShort(item) && state.included.has(item.key);
    }

    // 목표가 없으면(또는 0으로 꺼져 있으면) 비율 자체가 의미 없다 — null로 반환해서
    // 호출부(막대바/스파크라인 색 등)가 "없음"으로 표시하게 한다. 목표를 넘긴
    // 경우는 캡을 씌우지 않는다 — 120%면 120%로 그대로 보여야 과잉 재고가 눈에 띈다.
    function ratioOf(item) {
        if (hasNoTarget(item)) return null;
        return item.stocked / item.target;
    }

    /**
     * 이 속도면 며칠 뒤 바닥나는가. 소비가 없으면 Infinity.
     *
     * 계산 자체(최근 30일 감소분 기준 소비 속도)는 백엔드(GET /items의 daysLeft
     * 필드)로 옮겼다 — 그 계산엔 30일치 원본 이력이 필요한데, 프론트가 아이템마다
     * 그걸 다 받아 오는 것보다 서버가 숫자 하나만 내려주는 게 훨씬 가볍다. 여기선
     * null(=API가 "소비 없음"으로 판정)을 프론트 전역에서 계속 써 온 Infinity로
     * 바꿔주기만 한다 — 그래야 정렬·표시 쪽 기존 코드를 안 건드려도 된다.
     */
    function daysLeft(item) {
        return item.daysLeft == null ? Infinity : item.daysLeft;
    }

    /**
     * 매니페스트에 실을 수량. 기본은 부족분 전체지만 사용자나 오마카세가 조절할 수 있다.
     * 위쪽은 막지 않는다 — "오늘 운송 김에 여유분까지 미리 사 두자"처럼 부족분보다
     * 더 담는 것도 정당한 선택이라, 초과 자체는 buildManifestRow의 경고 표시로만
     * 알려주고 입력은 막지 않는다. 저장된 오버라이드가 현재 부족분과 같아지면(목표를
     * 낮췄거나 재고가 늘어난 경우) 읽는 시점에 오버라이드를 지운다 — 그래야 나중에
     * 목표가 또 바뀌어도 "전체"를 계속 따라간다.
     */
    function manifestQtyOf(item) {
        var max = deficit(item);
        var override = state.manifestQty[item.key];
        if (override == null) return max;
        return Math.max(0, override);
    }

    function setManifestQty(item, qty) {
        var max = deficit(item);
        var clamped = Math.max(0, isNaN(qty) ? 0 : Math.round(qty));
        if (clamped === max) delete state.manifestQty[item.key];
        else state.manifestQty[item.key] = clamped;
    }

    /** 함선 한 대에 저장된 피팅 모듈들의 typeId당 단가 조회 — pricing.js 배치에 얹혀 온다. */
    function fittingModulePrice(typeId) {
        return state.unitPrices["fitmod:" + typeId] || 0;
    }

    /** 함선 한 대의 피팅에 들어간 총 부피(모듈 부피 × 수량 합). 피팅 없으면 0. */
    function fittingUnitVolume(item) {
        var fit = state.fittings[item.key];
        if (!fit) return 0;
        return fit.items.reduce(function (sum, row) {
            var info = state.fittingTypeInfo[row.typeId] || {};
            return sum + (info.unitVolume || 0) * row.qty;
        }, 0);
    }

    /** 함선 한 대의 피팅에 들어간 총 비용. 가격 모르는 모듈은 0으로 친다(값을 지어내지 않는다는 앱 전체 원칙과 동일). */
    function fittingUnitCost(item) {
        var fit = state.fittings[item.key];
        if (!fit) return 0;
        return fit.items.reduce(function (sum, row) {
            return sum + fittingModulePrice(row.typeId) * row.qty;
        }, 0);
    }

    // 함선을 매니페스트에 N척 담으면 그 함선의 피팅 부피/비용도 N배로 같이 실린다 —
    // 헐값만으로는 실제 운송 부담을 과소평가하게 된다(사용자 확인).
    function manifestLineVolume(item) {
        return manifestQtyOf(item) * ((item.unitVolume || 0) + fittingUnitVolume(item));
    }

    function manifestLineCost(item) {
        return manifestQtyOf(item) * (unitPrice(item) + fittingUnitCost(item));
    }

    function unitPrice(item) {
        return state.unitPrices[item.key] || 0;
    }

    function iconSrc(item) {
        if (!item.typeId) return ICON_FALLBACK;
        return ICON_BASE + item.typeId + "/icon?size=64";
    }

    /* ── 데이터 적재 ─────────────────────────────────────── */

    function relativeSyncLabel(iso) {
        if (!iso) return "동기화 기록 없음";
        var diffMin = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
        if (diffMin < 1) return "방금 동기화";
        if (diffMin < 60) return diffMin + "분 전 동기화";
        return Math.round(diffMin / 60) + "시간 전 동기화";
    }

    // 백엔드가 ESI 콥 자산 응답의 Expires 헤더 기반으로 구조물별로 잡는 실제 다음
    // 동기화 예정 시각(TrackedStructure.nextSyncAt) — "방금 아이템을 넣었는데 언제
    // 반영되나"를 사용자가 감 잡을 수 있게 마지막 동기화 시각 옆에 같이 보여준다.
    function nextSyncLabel(iso) {
        if (!iso) return "";
        var diffMin = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
        if (diffMin <= 0) return "곧 동기화 예정";
        if (diffMin < 60) return diffMin + "분 후 동기화 예정";
        return Math.round(diffMin / 60) + "시간 후 동기화 예정";
    }

    function setupHangarSelect(structures) {
        if (!el.hangar) return;
        el.hangar.textContent = "";
        structures.forEach(function (s) {
            var opt = document.createElement("option");
            opt.value = s.structureId;
            opt.textContent = s.displayName;
            el.hangar.appendChild(opt);
        });
        el.hangar.value = state.structureId || structures[0].structureId;
    }

    /** division/컨테이너 쌍을 <select> option value 하나로 encode/decode. */
    function divisionOptionValue(division, containerName) {
        return String(division) + "::" + (containerName || "");
    }

    /**
     * 행어(division) 셀렉트를 GET /v1/stock/structures/:id/divisions 결과로 채운다.
     * 맨 앞엔 항상 "전체"(필터 없음) 옵션을 고정으로 둔다. 구조물을 바꿀 때마다 이
     * 목록 자체가 다르므로 선택은 항상 "전체"로 리셋한다.
     */
    function setupDivisionSelect(divisions) {
        if (!el.division) return;
        el.division.textContent = "";

        var allOpt = document.createElement("option");
        allOpt.value = "";
        allOpt.textContent = "전체";
        el.division.appendChild(allOpt);

        divisions.forEach(function (d) {
            var opt = document.createElement("option");
            opt.value = divisionOptionValue(d.division, d.containerName);
            opt.textContent = d.displayName;
            el.division.appendChild(opt);
        });

        state.division = null;
        state.container = null;
        el.division.value = "";
    }

    /**
     * 구조물을 바꿀 때 쓰는 경로: 그 구조물의 행어 목록을 새로 받아 셀렉트를
     * 리셋하고("전체"로), 재고를 불러온다. loadStockData() 단독 호출(1시간 자동
     * 새로고침, 행어 선택 변경)과 달리 여기서만 행어 목록 자체를 다시 받는다 —
     * 매 새로고침마다 다시 받으면 사용자가 골라 둔 행어 선택이 계속 리셋된다.
     */
    function loadStructureData(structureId) {
        return Promise.all([
            window.BonsaiApi.fetchDivisions(structureId)
                .then(setupDivisionSelect)
                .catch(function () {
                    // 행어 목록 조회 실패해도 전체 재고는 그대로 보여준다 — 필터 기능만 못 쓸 뿐.
                }),
            loadFittings(structureId),
        ]).then(function () {
            return loadStockData(structureId);
        });
    }

    // loadFittings는 구조물 전환/자동 새로고침이 겹쳐 불릴 수 있다 — loadStockData와
    // 같은 이유(위 주석 참고)로 번호를 매겨, 늦게 시작된 호출이 있으면 먼저 끝나도 버린다.
    var loadFittingsSeq = 0;

    /**
     * 이 구조물에 저장된 피팅 전부를 받아 state.fittings에 채우고, 거기 등장하는
     * 모듈 typeId들의 이름·부피도 미리 해석해 state.fittingTypeInfo에 채운다.
     * @param {string} structureId
     */
    function loadFittings(structureId) {
        var seq = ++loadFittingsSeq;
        return window.BonsaiApi.fetchFittings(structureId)
            .then(function (list) {
                if (seq !== loadFittingsSeq) return null; // 이 사이에 더 최신 호출이 시작됨 — 버린다.
                var fittings = {};
                var typeIds = [];
                (list || []).forEach(function (f) {
                    fittings[f.typeId + "::" + f.itemName] = {
                        items: f.items,
                        updatedAt: f.updatedAt,
                    };
                    f.items.forEach(function (row) {
                        typeIds.push(row.typeId);
                    });
                });
                state.fittings = fittings;
                return window.BonsaiEveTypes.resolveTypes(typeIds);
            })
            .then(function (typeInfo) {
                if (seq !== loadFittingsSeq || typeInfo == null) return;
                state.fittingTypeInfo = typeInfo || {};
            })
            .catch(function () {
                if (seq !== loadFittingsSeq) return;
                // item.key(typeId::itemName)엔 구조물 구분이 없어서, 조회 실패 시 이전
                // 구조물의 피팅을 그대로 두면 다른 구조물의 피팅이 지금 구조물의 같은
                // typeId/이름 함선에 잘못 붙을 수 있다 — "정보 없음"이 "틀린 정보"보다
                // 안전하므로 실패하면 아예 비운다(가격처럼 "이전 값 유지"가 안전한
                // typeId 전역 캐시와 다르다).
                state.fittings = {};
                state.fittingTypeInfo = {};
            });
    }

    /**
     * typeId만 있는 원본 아이템에 이름/그룹/부피를 붙인다. typeId→표시정보 해석은
     * 일부러 백엔드가 아니라 여기서 한다(파일 위 설명 참고). 해석 실패한 typeId는
     * 가짜 이름을 채우지 않고 "이름 미확인"으로 남긴다(pricing.js와 같은 원칙).
     */
    function attachTypeInfo(rawItems) {
        var typeIds = rawItems.map(function (r) {
            return r.typeId;
        });
        return window.BonsaiEveTypes.resolveTypes(typeIds).then(function (typeInfo) {
            return rawItems.map(function (raw) {
                var info = typeInfo[raw.typeId] || {};
                return {
                    typeId: raw.typeId,
                    // 함선처럼 게임 내 커스텀 이름(itemName)이 있으면 그게 곧 이 행의
                    // 정체성이다 — 타입명 대신 그대로 쓴다("세이버 x13"이 아니라 배마다
                    // 다른 이름으로 구분해서 보여주는 게 목적). group/unitVolume은 이름과
                    // 무관하게 typeId로만 정해진다.
                    itemName: raw.itemName || null,
                    // state.baseTarget/manifestQty/included/unitPrices 는 전부 이 key로
                    // 찾는다 — name이 아니다. 서로 다른 typeId의 함선 두 대가 커스텀명을
                    // 우연히 똑같이 지으면(예: 둘 다 "Bait") name만으로는 구분이 안 돼서
                    // 목표 편집·매니페스트 포함·단가가 서로 새 버린다. typeId를 같이
                    // 섞어야 항상 유일하다.
                    key: raw.typeId + "::" + (raw.itemName || ""),
                    name: raw.itemName || info.name || "이름 미확인 (typeId " + raw.typeId + ")",
                    // 커스텀명이 있으면 name이 그걸로 덮여서 원래 함선 타입명(예: "Punisher")이
                    // 사라진다 — "ฅ^•ﻌ•^ฅ 퍼_니셔"로도 "Punisher"로도 검색되게 하려면 타입명을
                    // 따로 들고 있어야 한다(visibleItems 검색에서 씀). 커스텀명이 없으면 name과
                    // 같은 값이라 중복이지만 무해하다.
                    typeName: info.name || "",
                    group: info.group || "",
                    unitVolume: info.unitVolume || 0,
                    stocked: raw.stocked,
                    target: raw.target,
                    daysLeft: raw.daysLeft,
                    // recentHistory는 {sampledAt, quantity} 쌍으로 온다. 스파크라인은
                    // 아직 "고정 간격 숫자 배열"을 가정하는 구조라 값만 뽑아 쓴다 —
                    // 시각 정보가 필요한 모달 전체 이력은 별도로 on-demand 조회한다.
                    history: (raw.recentHistory || []).map(function (p) {
                        return p.quantity;
                    }),
                };
            });
        });
    }

    // loadStockData는 최초 로드/행어 전환/자동 새로고침이 전부 공유하는 경로라
    // 겹쳐 불릴 수 있다(예: 페이지 열자마자 "전체"로 큰 요청이 나간 상태에서 바로
    // 특정 행어를 고르면 두 요청이 동시에 뜬다) — 응답이 "늦게 시작한 순"이 아니라
    // "늦게 도착한 순"으로 처리되면, 먼저 시작한 무거운 "전체" 요청이 나중에 끝나면서
    // 이미 반영된 특정 행어 결과를 덮어써 버린다(행어 선택 UI는 멀쩡한데 목록만 전체로
    // 보이는 버그의 원인이었다). 매 호출마다 번호를 매겨, 자기보다 늦게 시작된 호출이
    // 이미 있으면 응답이 와도 조용히 버린다.
    var loadStockDataSeq = 0;

    /**
     * 구조물 하나의 재고를 불러와 state.items를 채우고 다시 그린다. 최초 로드와
     * 자동 새로고침(scheduleAutoRefresh)이 공유하는 경로다.
     * @param {string} structureId
     */
    function loadStockData(structureId) {
        var seq = ++loadStockDataSeq;
        toast("조회중…", null, true);
        return window.BonsaiApi.fetchStockItems(structureId, {
            division: state.division,
            container: state.container,
        })
            .then(function (data) {
                if (seq !== loadStockDataSeq) return null; // 이 사이에 더 최신 요청이 시작됨 — 버린다.
                state.structureId = data.structure.structureId;
                if (el.sync) el.sync.textContent = relativeSyncLabel(data.structure.syncedAt);
                if (el.nextSync) el.nextSync.textContent = nextSyncLabel(data.structure.nextSyncAt);
                if (data.structure.syncedAt) {
                    state.sampledAt = new Date(data.structure.syncedAt).getTime();
                }
                scheduleAutoRefresh(data.structure.nextSyncAt);
                if (el.sampleMinutes) el.sampleMinutes.textContent = String(state.sampleMs / 60000);
                if (el.historyWindow) {
                    el.historyWindow.textContent = String(
                        (state.sparkPoints * state.sampleMs) / (60 * 60 * 1000)
                    );
                }
                return attachTypeInfo(data.items);
            })
            .then(function (items) {
                if (seq !== loadStockDataSeq || items == null) return; // 위와 같은 이유로 버린다.
                state.items = items;
                // 완전히 새 목록이라 이전 스크롤 위치가 의미가 없다 — 위로 되돌린다.
                if (el.tablewrap) el.tablewrap.scrollTop = 0;
                render();
                toast("조회 성공");
            })
            .catch(function (err) {
                if (seq !== loadStockDataSeq) return;
                // 실패해도 다음 자동 새로고침을 반드시 다시 예약한다 — 성공 경로의
                // scheduleAutoRefresh 호출까지 못 갔으니 여기서 안 하면 첫 조회가 실패하는
                // 순간 자동 새로고침 체인 자체가 영영 안 도는 것으로 끝나 버린다. nextSyncAt을
                // 모르니 폴백 간격(AUTO_REFRESH_FALLBACK_MS)으로 잡는다.
                scheduleAutoRefresh(null);
                toast(err.message || "조회 실패", "warn");
            });
    }

    var HUB_STORAGE_KEY = "bonsai:hub";

    /**
     * 상권 셀렉트를 pricing.js 의 HUBS 로 채우고, 저장해 둔 선택(있다면)을 복원한다.
     * 목록의 유일한 출처를 pricing.js 로 못박아 뒀다 — 여기서 다시 나열하면 나중에
     * 이름이나 순서가 어긋난다.
     */
    function setupHub() {
        if (!el.hub || !window.BonsaiPricing) return;

        var hubs = window.BonsaiPricing.HUBS || [];
        el.hub.textContent = "";
        hubs.forEach(function (hub) {
            var opt = document.createElement("option");
            opt.value = String(hub.id);
            opt.textContent = hub.name;
            el.hub.appendChild(opt);
        });

        var saved = parseInt(localStorage.getItem(HUB_STORAGE_KEY), 10);
        var valid = hubs.some(function (h) {
            return h.id === saved;
        });
        state.hub = valid ? saved : window.BonsaiPricing.DEFAULT_HUB_ID;
        el.hub.value = String(state.hub);

        el.hub.addEventListener("change", function () {
            state.hub = parseInt(el.hub.value, 10);
            localStorage.setItem(HUB_STORAGE_KEY, String(state.hub));
            state.priceSource = "조회 중…";
            state.priceOk = true;
            render();
            loadPrices();
        });
    }

    /**
     * 품목명 표시 언어(한국어/영어) 토글. eveTypes.js 가 로컬스토리지에 저장·유지한다 —
     * 여기서는 버튼 라벨을 맞추고, 누르면 이미 불러온 품목들의 이름을 새 언어로
     * 다시 가져온다(typeId는 그대로라 loadStockData 를 다시 부르면 충분하다).
     */
    function setupLangToggle() {
        if (!el.langToggle || !window.BonsaiEveTypes) return;

        function renderLangLabel() {
            var lang = window.BonsaiEveTypes.getLanguage();
            var isEn = lang === "en-us";
            el.langToggleLabel.textContent = isEn ? "EN" : "KO";
            el.langToggle.title = isEn
                ? "품목명을 영어로 표시 중 — 누르면 한국어로"
                : "품목명을 한국어로 표시 중 — 누르면 영어로";
        }
        renderLangLabel();

        el.langToggle.addEventListener("click", function () {
            var next = window.BonsaiEveTypes.getLanguage() === "en-us" ? "ko" : "en-us";
            window.BonsaiEveTypes.setLanguage(next);
            renderLangLabel();
            if (state.structureId) loadStockData(state.structureId);
        });
    }

    /**
     * 저장된 모든 피팅에 등장하는 모듈 typeId를 pricing.js 배치 조회용 형태로 모은다.
     * key를 typeId 기준 하나로 통일한다(같은 모듈이 여러 함선/피팅에 나와도 시세는
     * 하나) — "fitmod:" 접두어로 일반 재고 품목의 key(typeId+itemName)와 안 겹치게 한다.
     */
    function fittingPriceItems() {
        var seen = Object.create(null);
        var out = [];
        Object.keys(state.fittings).forEach(function (fitKey) {
            state.fittings[fitKey].items.forEach(function (row) {
                if (seen[row.typeId]) return;
                seen[row.typeId] = true;
                var info = state.fittingTypeInfo[row.typeId] || {};
                out.push({
                    key: "fitmod:" + row.typeId,
                    typeId: row.typeId,
                    unitVolume: info.unitVolume || 0,
                });
            });
        });
        return out;
    }

    function loadPrices() {
        if (!window.BonsaiPricing) return;
        var items = state.items.concat(fittingPriceItems());
        window.BonsaiPricing.fetchPrices(items, state.hub).then(function (result) {
            // 실패하면 이전에 받아 둔 값(있다면)을 지우지 않는다 — 나중에 주기적 재조회를
            // 붙였을 때, 일시적 실패로 화면의 모든 비용이 "—"로 사라지는 것보다 낫다.
            // 첫 로드 실패라면 어차피 아직 아무 값도 없었으니 차이가 없다.
            if (result.ok) state.unitPrices = result.unitPrices || {};
            state.priceSource = result.source || "—";
            state.priceOk = result.ok !== false;
            state.priceApprox = !!result.approx;
            render();
            // 캡션 톤만으로는 놓치기 쉽다 — 발생한 순간 한 번은 명시적으로 알린다.
            if (!state.priceOk) {
                toast("시세 조회에 실패했습니다. 예상 비용이 최신이 아닐 수 있습니다.", "warn");
            } else if (state.priceApprox) {
                toast("실시간 시세를 받지 못해 ESI 평균가로 대신합니다.", "warn");
            }
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
        stocked: {
            value: function (i) {
                return i.stocked;
            },
            asc: "적은 순",
            desc: "많은 순",
        },
        volume: {
            value: function (i) {
                return i.unitVolume || 0;
            },
            desc: "큰 순",
            asc: "작은 순",
        },
        price: { value: unitPrice, desc: "비싼 순", asc: "싼 순" },
        name: { value: null, asc: "가나다 순", desc: "역순" },
    };

    function sortItems(list) {
        var spec = SORT[state.sort.key] || SORT.days;
        var sign = state.sort.asc ? 1 : -1;

        return list.slice().sort(function (a, b) {
            if (!spec.value) return sign * a.name.localeCompare(b.name, "ko");
            var av = spec.value(a);
            var bv = spec.value(b);
            // null(목표 없음이라 비율 계산 불가, ratioOf 참고)도 Infinity와 똑같이
            // 취급한다 — isFinite(null)이 true라서 그냥 두면 0으로 취급돼 "가장 부족한
            // 품목"으로 잘못 섞여 들어간다.
            if (av == null) av = Infinity;
            if (bv == null) bv = Infinity;
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

        // 표 헤더 중 지금 정렬 기준인 것만 강조하고 화살표로 방향을 보여준다.
        document.querySelectorAll("[data-sort-key]").forEach(function (btn) {
            var active = btn.getAttribute("data-sort-key") === state.sort.key;
            btn.classList.toggle("is-active", active);
            btn.setAttribute("aria-sort", active ? (state.sort.asc ? "ascending" : "descending") : "none");
            var arrow = btn.querySelector(".th-sort__arrow");
            if (arrow) arrow.textContent = active ? (state.sort.asc ? "▲" : "▼") : "";
        });
    }

    /* ── 표시 대상 ──────────────────────────────────────── */

    function visibleItems() {
        var q = state.query.trim().toLowerCase();
        var kept = state.items.filter(function (item) {
            if (state.filter === "short" && !isShort(item)) return false;
            if (state.filter === "ok" && (hasNoTarget(item) || isShort(item))) return false;
            if (state.filter === "notarget" && !hasNoTarget(item)) return false;
            if (!q) return true;
            // 함선은 name이 커스텀명으로 덮여 있어도, 원래 함선 타입명(예: "Punisher"
            // 또는 "퍼니셔" — 표시 언어에 따라 달라진다)으로도 찾을 수 있어야 한다.
            return (
                item.name.toLowerCase().indexOf(q) !== -1 ||
                (item.typeName && item.typeName.toLowerCase().indexOf(q) !== -1) ||
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

        var track = document.createElement("div");
        track.className = "bar__track";
        track.style.setProperty("--fill", rampColor(ratio));
        track.setAttribute("role", "img");

        if (ratio == null) {
            track.setAttribute("aria-label", "목표 없음");
            var noneLabel = document.createElement("span");
            noneLabel.className = "bar__pct";
            noneLabel.textContent = "없음";
            track.appendChild(noneLabel);
            return track;
        }

        var pct = Math.round(ratio * 100);
        track.setAttribute("aria-label", "목표 대비 " + pct + "%");

        var fill = document.createElement("div");
        fill.className = "bar__fill" + (state.firstPaint ? " is-new" : "");
        // 막대 너비 자체는 트랙을 넘길 수 없으니 100%에서 캡 — 그 이상은 --over 마커와
        // 퍼센트 숫자(캡 없음)로 표현한다.
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
        if (!(item.key in state.baseTarget)) state.baseTarget[item.key] = item.target;
        item.target = next;
        // 원래 값으로 되돌아왔으면 변경이 아니다.
        if (state.baseTarget[item.key] === next) delete state.baseTarget[item.key];
    }

    function isDirty(item) {
        return item.key in state.baseTarget;
    }

    function pendingChanges() {
        return state.items
            .filter(isDirty)
            .map(function (item) {
                return { item: item, from: state.baseTarget[item.key], to: item.target };
            });
    }

    function renderPending() {
        var changes = pendingChanges();
        el.pending.hidden = changes.length === 0;
        el.pendingCount.textContent = num(changes.length);
    }

    function resetTargets() {
        state.items.forEach(function (item) {
            if (isDirty(item)) item.target = state.baseTarget[item.key];
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

        if (on) {
            state.included.add(item.key);
        } else {
            state.included.delete(item.key);
            // 다시 체크하면 항상 그 시점의 전체 부족분에서 시작한다 — 예전에 줄여 뒀던
            // 수량을 기억해 뒀다가 불쑥 되돌리면 놀란다.
            delete state.manifestQty[item.key];
        }

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
        // 움직이지 않았다 = 클릭.
        if (started.fromPick || started.fromName) return; // 자기 핸들러가 처리하므로 비켜 준다
        if (started.fromPickZone) {
            // 체크박스를 살짝 벗어나 옆 아이콘을 눌러도 토글되게 한다 — 체크박스 자체의
            // 시각 크기는 그대로 두고 클릭 판정만 넓힌 것이다. 여기는 네이티브 change
            // 이벤트가 안 오니 직접 토글한다.
            if (isShort(started.item)) {
                applyInclusion(started.item, !included(started.item));
                renderManifest();
            }
            return;
        }
        if (open) openDetail(started.item);
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
            // 체크박스 칸 + 바로 옆 아이콘 칸까지는 "선택" 의도로 본다. 실제 네이티브
            // 체크박스(.pick)는 위에서 이미 따로 잡았으니 여기서는 그 나머지만 표시한다.
            fromPickZone: !!e.target.closest(".tbl__pick, .tbl__ico") && !e.target.closest(".pick"),
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
        fittingSection: document.querySelector("[data-modal-fitting]"),
        fittingToggle: document.querySelector("[data-fitting-toggle]"),
        fittingChevron: document.querySelector("[data-fitting-chevron]"),
        fittingToggleLabel: document.querySelector("[data-fitting-toggle-label]"),
        fittingItems: document.querySelector("[data-fitting-items]"),
        fittingEdit: document.querySelector("[data-fitting-edit]"),
        fittingDelete: document.querySelector("[data-fitting-delete]"),
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
        modal.target.textContent = hasNoTarget(item) ? "미설정" : num(item.target);
        modal.short.textContent = short ? "−" + num(short) : hasNoTarget(item) ? "목표없음" : "충족";
        modal.short.className = "stat__v " + (short ? "short" : "ok");
        renderModalFitting(item);

        // 차트는 모달을 연 뒤에 그린다 — 닫힌 dialog 는 폭이 0이라 viewBox 를 맞출 수 없다.
        modal.root.showModal();

        // 모달을 열 때마다 기본 구간(7일)으로 되돌린다 — 직전 품목에서 좁혀 둔 범위가
        // 다음 품목에 따라붙으면 무엇을 보고 있는지 헷갈린다. 서버에서 그만큼만 새로
        // 받아 오므로(on-demand) 여기서 fetch가 끝난 뒤에 그린다.
        setPreset(item, "7").then(function () {
            drawChart(item);
        });
    }

    /**
     * 모달 하단 피팅 섹션을 채운다. 피팅은 커스텀명 있는 함선 전용이라 일반
     * 품목이면 섹션 자체를 숨긴다.
     */
    function renderModalFitting(item) {
        if (!item.itemName) {
            modal.fittingSection.hidden = true;
            return;
        }
        modal.fittingSection.hidden = false;
        modal.fittingItems.hidden = true;
        modal.fittingToggle.setAttribute("aria-expanded", "false");

        var fit = state.fittings[item.key];
        modal.fittingDelete.hidden = !fit;
        modal.fittingEdit.textContent = fit ? "수정" : "피팅 등록";

        if (!fit) {
            modal.fittingToggle.disabled = true;
            modal.fittingToggleLabel.textContent = "피팅 미등록";
            modal.fittingItems.textContent = "";
            return;
        }
        modal.fittingToggle.disabled = false;
        modal.fittingToggleLabel.textContent = "피팅 " + fit.items.length + "종";
        renderFittingItemsList(modal.fittingItems, fit.items);
    }

    /** 피팅 아이템 목록(typeId/qty)을 읽기 전용 행으로 그린다 — 모달·매니페스트 공용. */
    function renderFittingItemsList(ul, items) {
        ul.textContent = "";
        items.forEach(function (row) {
            var info = state.fittingTypeInfo[row.typeId] || {};
            var li = document.createElement("li");
            li.className = "fitting__item";

            var img = document.createElement("img");
            img.className = "fitting__item-icon";
            img.width = 22;
            img.height = 22;
            img.alt = "";
            img.src = ICON_BASE + row.typeId + "/icon?size=32";
            img.addEventListener("error", function once() {
                img.removeEventListener("error", once);
                img.src = ICON_FALLBACK;
            });
            li.appendChild(img);

            var name = document.createElement("span");
            name.className = "fitting__item-name";
            name.textContent = info.name || "typeId " + row.typeId;
            li.appendChild(name);

            var qty = document.createElement("span");
            qty.className = "fitting__item-qty";
            qty.textContent = "×" + num(row.qty);
            li.appendChild(qty);

            ul.appendChild(li);
        });
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
            " · " +
            state.sampleMs / 60000 +
            "분 간격 · 점선은 목표 수량";
    }

    var HISTORY_DAYS_BY_PRESET = { 1: 1, 7: 7, 30: 30, all: 365 };

    /**
     * 프리셋(일수 또는 "all")만큼 서버에서 그 아이템의 이력을 새로 받아 온다.
     * 목록 조회 때 온 recentHistory(최근 24건)로는 모달의 큰 구간을 못 보여주므로
     * on-demand로 따로 조회한다 — 매번 90일치를 다 들고 다닐 필요가 없어서다.
     * @returns {Promise<void>}
     */
    function setPreset(item, preset) {
        range.preset = preset;
        var days = HISTORY_DAYS_BY_PRESET[preset] || 7;
        return window.BonsaiApi.fetchItemHistory(
            state.structureId,
            item.typeId,
            days,
            item.itemName
        )
            .then(function (res) {
                item.history = (res.history || []).map(function (p) {
                    return p.quantity;
                });
                range.from = 0;
                range.to = Math.max(0, item.history.length - 1);
                syncRangeControls(item);
            })
            .catch(function (err) {
                toast(err.message || "조회 실패", "warn");
            });
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
            setPreset(openItem, btn.getAttribute("data-range")).then(function () {
                drawChart(openItem);
            });
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
        name.title = item.name; // 가상 스크롤 행 높이를 고정하려고 한 줄로 자르니, 전체 이름은 호버로.
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
        input.value = hasNoTarget(item) ? "" : String(item.target);
        input.placeholder = "목표 설정";
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
        shortMain.textContent = short ? "−" + num(short) : hasNoTarget(item) ? "목표없음" : "충족";
        tdShort.appendChild(shortMain);
        // 가상 스크롤이 행 높이를 고정값으로 가정하므로, 소진 예상일이 없는 행도
        // 빈 줄을 그대로 둔다(항상 2줄) — isk__unit과 같은 이유로 조건부 append를 뺐다.
        // 목표가 없으면 애초에 추적 중이 아니라는 뜻이라, 소진 예측은 관리 대상이
        // 아닌 아이템에 대한 불필요한 정보다 — daysLeft 자체는 target과 무관하게
        // 소비 추세만 보고 계산되므로 여기서 따로 걸러야 한다.
        var left = daysLeft(item);
        var showRunout = isFinite(left) && !hasNoTarget(item);
        var runOut = document.createElement("span");
        runOut.className = "runout" + (showRunout && left <= 3 ? " is-soon" : "");
        runOut.textContent = showRunout
            ? (left < 10 ? Math.round(left * 10) / 10 : Math.round(left)) + "일 남음"
            : "";
        tdShort.appendChild(runOut);
        tr.appendChild(tdShort);

        // 예상 비용(총액)은 표에서 뺐다 — 담지도 않은 걸 매 행마다 숫자로 박아 두는 게
        // 오히려 오해를 샀다(목표 없는 아이템은 항상 0이라 "조회가 안 된다"로 보임).
        // 실제로 살지/옮길지 정한 뒤의 총액은 매니페스트 쪽에서만 보여준다. 개당 부피/개당
        // 비용은 재고 상태와 무관한 품목 고유 성질이라 남겨 둔다 — "여유 공간 30m³엔 뭐가
        // 몇 개 들어가나, 그거 하나에 얼마인가"를 목록만 보고 가늠하려면 필요하다.
        var tdVolume = document.createElement("td");
        tdVolume.className = "tbl__n tbl__vol";
        tdVolume.textContent = item.unitVolume ? volume(item.unitVolume) + " m³" : "—";
        tr.appendChild(tdVolume);

        var tdPrice = document.createElement("td");
        tdPrice.className = "tbl__n tbl__price";
        tdPrice.textContent = unitPrice(item) ? unitPriceLabel(unitPrice(item)) + "/개" : "—";
        tr.appendChild(tdPrice);

        return tr;
    }

    /* ── 렌더: 매니페스트 ───────────────────────────────── */

    function manifestItems() {
        return state.items.filter(included);
    }

    function manifestText() {
        // EVE 멀티바이는 "품목명<TAB>수량" 줄을 읽는다. 이름은 인게임 표기와 정확히 일치해야 한다.
        // 수량 0인 줄은 내보내지 않는다 — 사용자가 매니페스트에서 0으로 낮춘 품목까지
        // 붙여넣기에 실리면 멀티바이 창에 의미 없는 줄이 남는다.
        return manifestItems()
            .filter(function (item) {
                return manifestQtyOf(item) > 0;
            })
            .map(function (item) {
                return item.name + "\t" + manifestQtyOf(item);
            })
            .join("\n");
    }

    function buildManifestRow(item) {
        var frag = document.createDocumentFragment();
        var tr = document.createElement("tr");
        tr.className = "mrow";

        var fit = state.fittings[item.key];
        var fitRow = null; // 피팅 있으면 아래서 채운다(펼치기 토글 대상).

        var tdItem = document.createElement("td");
        tdItem.className = "mtbl__item";
        var wrap = document.createElement("div");
        wrap.className = "mrow__item";

        if (fit) {
            var toggle = document.createElement("button");
            toggle.type = "button";
            toggle.className = "mrow__toggle";
            toggle.textContent = "▾";
            toggle.setAttribute("aria-label", item.name + " 피팅 펼치기/접기");
            toggle.setAttribute("aria-expanded", "false");
            toggle.addEventListener("click", function () {
                var open = fitRow.hidden;
                fitRow.hidden = !open;
                toggle.setAttribute("aria-expanded", open ? "true" : "false");
                toggle.classList.toggle("is-open", open);
            });
            wrap.appendChild(toggle);
        }

        var img = document.createElement("img");
        img.className = "micon";
        img.width = 20;
        img.height = 20;
        img.alt = "";
        img.loading = "lazy";
        img.src = iconSrc(item);
        img.addEventListener("error", function once() {
            img.removeEventListener("error", once);
            img.src = ICON_FALLBACK;
        });
        var name = document.createElement("span");
        name.className = "mname";
        name.textContent = item.name;
        name.title = item.name; // 좁은 열에서 ellipsis 로 잘려도 호버하면 전체 이름이 보인다
        wrap.appendChild(img);
        wrap.appendChild(name);
        tdItem.appendChild(wrap);
        tr.appendChild(tdItem);

        // 수량 — 매니페스트의 조절 지점. 부족분이 기본이지만 위쪽은 막지 않는다("오늘
        // 가는 김에 여유분도 미리 사 두자"). 대신 부족분을 넘기면 옆에 작은 경고를 띄운다.
        var tdQty = document.createElement("td");
        tdQty.className = "mtbl__n mtbl__qty";
        var qtyWrap = document.createElement("span");
        qtyWrap.className = "mqty__wrap";
        var qty = document.createElement("input");
        qty.type = "number";
        qty.min = "0";
        qty.className = "mqty";
        var currentQty = manifestQtyOf(item);
        qty.value = String(currentQty);
        qty.setAttribute("aria-label", item.name + " 매니페스트 수량");
        qty.addEventListener("change", function () {
            setManifestQty(item, parseInt(qty.value, 10));
            renderManifest();
        });
        qtyWrap.appendChild(qty);
        var deficitQty = deficit(item);
        var over = currentQty - deficitQty;
        if (over > 0) {
            var warn = document.createElement("span");
            warn.className = "mqty__warn";
            warn.textContent = "▲";
            warn.setAttribute("aria-hidden", "true");
            // 그냥 "N개 초과"만 쓰면 기준(목표=부족분)이 몇 개였는지 몰라 숫자만 봐선
            // 얼마나 더 담은 건지 가늠이 안 된다 — 기준값을 같이 보여준다.
            warn.title = "목표 " + num(deficitQty) + "개 · 초과 " + num(over) + "개";
            qtyWrap.appendChild(warn);
            qty.setAttribute(
                "aria-label",
                item.name + " 매니페스트 수량, 목표 " + num(deficitQty) + "개 중 " + num(over) + "개 초과"
            );
        }
        tdQty.appendChild(qtyWrap);
        tr.appendChild(tdQty);

        var tdVol = document.createElement("td");
        tdVol.className = "mtbl__n";
        tdVol.textContent = volume(manifestLineVolume(item)) + " m³";
        tr.appendChild(tdVol);

        var tdCost = document.createElement("td");
        tdCost.className = "mtbl__n";
        var cost = document.createElement("span");
        cost.className = "mcost";
        cost.textContent = isk(manifestLineCost(item));
        var unit = document.createElement("span");
        unit.className = "mcost__unit";
        unit.textContent = unitPrice(item) ? unitPriceLabel(unitPrice(item)) + "/개" : "";
        tdCost.appendChild(cost);
        tdCost.appendChild(unit);
        tr.appendChild(tdCost);

        var tdDrop = document.createElement("td");
        tdDrop.className = "mtbl__drop";
        var drop = document.createElement("button");
        drop.type = "button";
        drop.className = "mdrop";
        drop.textContent = "✕";
        drop.setAttribute("aria-label", item.name + " 매니페스트에서 빼기");
        drop.addEventListener("click", function () {
            applyInclusion(item, false);
            render();
        });
        tdDrop.appendChild(drop);
        tr.appendChild(tdDrop);

        frag.appendChild(tr);

        if (fit) {
            fitRow = document.createElement("tr");
            fitRow.className = "mrow__fit";
            fitRow.hidden = true;
            var fitTd = document.createElement("td");
            fitTd.colSpan = 5;
            var fitList = document.createElement("ul");
            fitList.className = "fitting__items";
            renderFittingItemsList(fitList, fit.items);
            fitTd.appendChild(fitList);
            fitRow.appendChild(fitTd);
            frag.appendChild(fitRow);
        }

        return frag;
    }

    function renderManifest() {
        var picked = manifestItems();

        el.manifestRows.textContent = "";
        picked.forEach(function (item) {
            el.manifestRows.appendChild(buildManifestRow(item));
        });
        el.manifestEmpty.hidden = picked.length !== 0;

        var vol = picked.reduce(function (sum, item) {
            return sum + manifestLineVolume(item);
        }, 0);
        var cost = picked.reduce(function (sum, item) {
            return sum + manifestLineCost(item);
        }, 0);
        var lines = picked.filter(function (item) {
            return manifestQtyOf(item) > 0;
        }).length;

        el.manifestLines.textContent = num(lines);
        el.manifestVolume.textContent = volume(vol);
        el.manifestIsk.textContent = cost > 0 ? iskTotal(cost) : "—";
        el.copy.disabled = lines === 0;
    }

    /* ── 렌더: 가상 스크롤 ──────────────────────────────── */

    // .tbl tbody tr.row 의 CSS height(52px)와 반드시 일치해야 한다 — 어긋나면
    // 스크롤할수록 렌더된 구간과 실제 스크롤 위치가 밀린다.
    var ROW_H = 52;
    // <colgroup>의 <col> 개수(pick·ico·item·spark·bar·qty·short·vol·price)와 같아야
    // spacer 행의 colspan이 표 전체 폭을 정확히 덮는다.
    var TBL_COLS = 9;
    // 스크롤이 튀는 순간에도 빈 틈이 먼저 보이지 않게, 화면 위아래로 더 그려 두는 여유 행 수.
    var ROW_BUFFER = 8;

    function spacerRow(height) {
        var tr = document.createElement("tr");
        tr.className = "row-spacer";
        tr.setAttribute("aria-hidden", "true");
        tr.style.height = height + "px";
        var td = document.createElement("td");
        td.colSpan = TBL_COLS;
        td.style.padding = "0";
        td.style.border = "0";
        tr.appendChild(td);
        return tr;
    }

    // app.css 의 "@media (max-width: 640px)" 카드 레이아웃 분기점과 반드시 같아야 한다.
    var MOBILE_MQ = window.matchMedia("(max-width: 640px)");
    // 회전·창 크기 조절로 이 경계를 넘나들면 가상 스크롤 on/off 를 다시 판단해야 한다.
    MOBILE_MQ.addEventListener("change", function () {
        render();
    });

    /**
     * 몇백~몇천 개짜리 목록이어도 실제로 DOM에 만드는 <tr>은 화면에 보이는
     * 구간(+버퍼)뿐이다 — 나머지는 위/아래 spacer 행 하나씩으로 높이만 채운다.
     * 정렬·검색·필터가 바뀌어도 이 함수만 다시 부르면 되므로, 예전에 있던
     * "이미 만든 행을 재사용해 옮기기만 하는" resortRows() 같은 별도 최적화 경로가
     * 더는 필요 없다 — 어차피 매번 화면에 보이는 몇십 행만 새로 만들기 때문이다.
     *
     * 모바일 폭에서는 표가 카드로 접히면서 품목명 줄바꿈 등으로 행 높이가 들쭉날쭉해져
     * ROW_H 고정 가정이 깨진다. 그 폭에서는 가상 스크롤을 접고 예전처럼 전부 그린다 —
     * 손 안 화면에서 수백~수천 개를 오래 스크롤하는 경우는 드물다고 보고 단순한 쪽을 택했다.
     */
    function renderWindow() {
        var items = visibleItems();

        if (MOBILE_MQ.matches) {
            el.rows.textContent = "";
            items.forEach(function (item, i) {
                el.rows.appendChild(buildRow(item, i));
            });
            return items;
        }

        var viewportH = el.tablewrap.clientHeight || 0;
        var scrollTop = el.tablewrap.scrollTop || 0;
        var start = Math.max(0, Math.floor(scrollTop / ROW_H) - ROW_BUFFER);
        var count = Math.ceil(viewportH / ROW_H) + ROW_BUFFER * 2;
        var end = Math.min(items.length, start + count);

        el.rows.textContent = "";
        if (start > 0) el.rows.appendChild(spacerRow(start * ROW_H));
        for (var i = start; i < end; i++) {
            el.rows.appendChild(buildRow(items[i], i));
        }
        if (end < items.length) el.rows.appendChild(spacerRow((items.length - end) * ROW_H));

        return items;
    }

    function render() {
        el.priceSource.textContent = state.priceSource;
        // 조회 실패/근사값은 캡션 텍스트만으로는 눈에 안 띄니 톤을 바꿔 잡아 준다 — 시세는
        // 계속 바뀌는 값이라 "지금 값이 실시간이 아니다"는 사실이 조용히 묻히면 안 된다.
        // is-warn(빨강)은 완전 실패, is-approx(주황)는 다른 종류의 값으로 대체된 상태다.
        el.priceNote.classList.toggle("is-warn", !state.priceOk);
        el.priceNote.classList.toggle("is-approx", state.priceOk && state.priceApprox);

        var items = renderWindow();

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

    /**
     * Promise.all이 아니라 allSettled를 쓴다 — 여러 건을 한 번에 저장할 때 하나가
     * 실패했다고 이미 서버에 반영된 나머지까지 "저장 안 됨" 상태로 묶어 두면 안 된다
     * (묶어 두면 "되돌리기"를 눌렀을 때 이미 저장된 값까지 로컬에서 옛날 값으로
     * 되돌아가 버려서 서버와 어긋난다). 성공한 것만 baseTarget에서 지우고, 실패한
     * 것만 dirty 상태로 남겨서 다시 저장할 수 있게 한다.
     */
    function commitTargets() {
        var changes = pendingChanges();
        toast("저장중…", null, true);
        Promise.allSettled(
            changes.map(function (c) {
                return window.BonsaiApi.saveTarget(state.structureId, {
                    typeId: c.item.typeId,
                    itemName: c.item.itemName,
                    targetQty: c.to,
                }).then(function () {
                    return c;
                });
            })
        ).then(function (results) {
            var succeeded = 0;
            var failed = 0;
            results.forEach(function (r) {
                if (r.status === "fulfilled") {
                    delete state.baseTarget[r.value.item.key];
                    succeeded++;
                } else {
                    failed++;
                }
            });

            saveModal.root.close();
            render();

            if (failed === 0) {
                toast(num(succeeded) + "건을 저장했습니다.");
            } else if (succeeded === 0) {
                toast("저장 중 오류가 발생했습니다. 다시 시도해주세요.", "warn");
            } else {
                toast(
                    num(succeeded) + "건 저장, " + num(failed) + "건 실패 — 실패한 항목은 다시 저장해주세요.",
                    "warn"
                );
            }
        });
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

    /* ── 피팅 붙여넣기 모달 ─────────────────────────────── */
    // 품목 추가 모달(add-modal)과 거의 같은 흐름이다: 붙여넣기 → 이브에서 확인 →
    // 못 찾은 이름은 걸러내거나 고치게 하고 → 확정. 다른 점은 파서(parseEft)와
    // 저장 대상(피팅 아이템 typeId/qty, 백엔드 ShipFitting)뿐이라 같은 CSS 클래스를
    // 그대로 재사용한다(add__body/add__input/add__list/add__row 등).

    var fittingModal = {
        root: document.querySelector("[data-fitting-modal]"),
        title: document.querySelector("[data-fitting-modal-title]"),
        text: document.querySelector("[data-fitting-text]"),
        check: document.querySelector("[data-fitting-check]"),
        status: document.querySelector("[data-fitting-status]"),
        list: document.querySelector("[data-fitting-list]"),
        confirm: document.querySelector("[data-fitting-confirm]"),
    };

    // 확인 결과. { typeId, name, language, qty } 또는 { name, missing: true }
    var fittingRows = [];
    // 지금 등록/수정 중인 함선 item(typeId/itemName/key 필요) — openFittingModal이 잡는다.
    var fittingModalTarget = null;

    function setFittingModalStatus(text, tone) {
        fittingModal.status.hidden = !text;
        fittingModal.status.textContent = text || "";
        if (tone) fittingModal.status.setAttribute("data-tone", tone);
        else fittingModal.status.removeAttribute("data-tone");
    }

    function renderFittingModalRows() {
        fittingModal.list.textContent = "";

        fittingRows.forEach(function (row, index) {
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
                qty.min = "1";
                qty.className = "add__qty";
                qty.value = String(row.qty);
                qty.setAttribute("aria-label", row.name + " 수량");
                qty.addEventListener("change", function () {
                    var v = parseInt(qty.value, 10);
                    row.qty = isNaN(v) || v < 1 ? 1 : v;
                });
                li.appendChild(qty);
            }

            var drop = document.createElement("button");
            drop.type = "button";
            drop.className = "add__drop";
            drop.textContent = "✕";
            drop.setAttribute("aria-label", row.name + " 목록에서 빼기");
            drop.addEventListener("click", function () {
                fittingRows.splice(index, 1);
                renderFittingModalRows();
            });
            li.appendChild(drop);

            fittingModal.list.appendChild(li);
        });

        var missing = fittingRows.filter(function (r) {
            return r.missing;
        }).length;
        var ok = fittingRows.length - missing;
        fittingModal.confirm.disabled = ok === 0 || missing > 0;

        if (missing) {
            setFittingModalStatus(
                missing + "개를 찾을 수 없습니다. 이름을 고치거나 목록에서 빼야 저장할 수 있습니다.",
                "warn"
            );
        } else if (ok) {
            setFittingModalStatus(ok + "종을 확인했습니다.");
        } else {
            setFittingModalStatus("");
        }
    }

    function checkFittingText() {
        var parsed = window.BonsaiEsi.parseEft(fittingModal.text.value);
        if (!parsed.length) {
            fittingRows = [];
            renderFittingModalRows();
            setFittingModalStatus("붙여넣은 피팅이 비어 있습니다.", "warn");
            return;
        }

        fittingModal.check.disabled = true;
        setFittingModalStatus("이브에서 확인하는 중…");

        var names = parsed.map(function (p) {
            return p.name;
        });

        window.BonsaiEsi.resolveNames(names).then(
            function (res) {
                fittingRows = parsed.map(function (p) {
                    var hit = res.found[p.name.toLowerCase()];
                    if (!hit) return { name: p.name, missing: true };
                    return { typeId: hit.id, name: hit.name, language: hit.language, qty: p.qty };
                });
                fittingModal.check.disabled = false;
                renderFittingModalRows();
            },
            function (err) {
                fittingModal.check.disabled = false;
                setFittingModalStatus("이브에 연결하지 못했습니다: " + (err && err.message), "warn");
            }
        );
    }

    function openFittingModal(item) {
        fittingModalTarget = item;
        fittingRows = [];
        fittingModal.text.value = "";
        renderFittingModalRows();
        setFittingModalStatus("");
        fittingModal.title.textContent = item.name + " 피팅";
        fittingModal.root.showModal();
        fittingModal.text.focus();
    }

    function commitFitting() {
        var rows = fittingRows.filter(function (r) {
            return !r.missing;
        });
        if (!rows.length || !fittingModalTarget) return;

        var item = fittingModalTarget;
        fittingModal.confirm.disabled = true;
        window.BonsaiApi.saveFitting(state.structureId, {
            typeId: item.typeId,
            itemName: item.itemName,
            items: rows.map(function (r) {
                return { typeId: r.typeId, qty: r.qty };
            }),
        })
            .then(function () {
                return loadFittings(state.structureId);
            })
            .then(function () {
                fittingModal.root.close();
                fittingModal.confirm.disabled = false;
                if (openItem && openItem.key === item.key) renderModalFitting(openItem);
                loadPrices();
                render();
                toast("피팅을 저장했습니다.");
            })
            .catch(function (err) {
                fittingModal.confirm.disabled = false;
                toast(err.message || "피팅 저장 실패", "warn");
            });
    }

    function deleteFitting(item) {
        if (!window.confirm(item.name + "의 피팅을 삭제할까요?")) return;
        window.BonsaiApi.saveFitting(state.structureId, {
            typeId: item.typeId,
            itemName: item.itemName,
            items: [],
        })
            .then(function () {
                return loadFittings(state.structureId);
            })
            .then(function () {
                if (openItem && openItem.key === item.key) renderModalFitting(openItem);
                loadPrices();
                render();
                toast("피팅을 삭제했습니다.");
            })
            .catch(function (err) {
                toast(err.message || "피팅 삭제 실패", "warn");
            });
    }

    /* ── 토스트 ─────────────────────────────────────────── */

    var toastTimer = null;

    /**
     * @param {boolean} [busy] true면 자동으로 안 사라진다 — 오래 걸리는 조회 중에
     *        "조회중…"이 2.6초 만에 사라지면 그새 멈춘 줄 알기 쉽다. 도는 표시(spin)를
     *        곁들여 "기다리면 된다"를 보여주고, 조회가 끝나 결과 toast()가 다시 불릴
     *        때(busy 없이) 정상적으로 사라지게 둔다.
     */
    function toast(message, tone, busy) {
        el.toastText.textContent = message;
        if (tone) el.toast.setAttribute("data-tone", tone);
        else el.toast.removeAttribute("data-tone");
        if (busy) el.toast.setAttribute("data-busy", "");
        else el.toast.removeAttribute("data-busy");
        el.toast.hidden = false;
        clearTimeout(toastTimer);
        if (busy) return;
        toastTimer = setTimeout(function () {
            el.toast.hidden = true;
        }, 2600);
    }

    /* ── 오마카세: 적재량 안에서 우선순위대로 채운다 ─────── */

    /**
     * 후보를 소진 예상일 오름차순(가장 급한 것부터)으로 정렬하고, 적재량이 허락하는
     * 만큼 채운다. 품목 하나 안에서는 전량 아니면 포기가 아니라 남는 용량만큼만
     * 부분적으로 담는다 — 부피가 일정한 개별 유닛의 합이라 0/1 배낭으로 풀 이유가 없고,
     * 그러면 용량을 셀 단위로 접는 DP가 소수점 부피 품목(탄약 0.0125 m³ 등)에서 배열이
     * 수백만 칸으로 터지는 것도 피한다.
     *
     * 순수 함수다 — state 를 건드리지 않는다. 두 호출부(전체 재고 대상, 매니페스트
     * 대상)가 후보 목록만 다르게 넘기고 알고리즘은 그대로 공유한다.
     *
     * @param {Array<{item: object, maxQty: number}>} candidates
     * @param {number} capacityM3
     * @returns {{picks: Array<{item, qty}>, usedVolume: number, skipped: Array<object>}}
     */
    function omakase(candidates, capacityM3) {
        var sorted = candidates
            .filter(function (c) {
                return c.maxQty > 0;
            })
            .slice()
            .sort(function (a, b) {
                var au = daysLeft(a.item);
                var bu = daysLeft(b.item);
                if (!isFinite(au) && !isFinite(bu)) return 0;
                if (!isFinite(au)) return 1;
                if (!isFinite(bu)) return -1;
                return au - bu;
            });

        var remaining = Math.max(0, capacityM3);
        var picks = [];
        var skipped = [];

        sorted.forEach(function (c) {
            var v = c.item.unitVolume || 0;
            var qty = v <= 0 ? c.maxQty : Math.min(c.maxQty, Math.floor(remaining / v));
            if (qty <= 0) {
                skipped.push(c.item);
                return;
            }
            picks.push({ item: c.item, qty: qty });
            remaining -= qty * v;
        });

        return { picks: picks, usedVolume: capacityM3 - remaining, skipped: skipped };
    }

    var omakaseModal = {
        root: document.querySelector("[data-omakase-modal]"),
        title: document.querySelector("[data-omakase-title]"),
        desc: document.querySelector("[data-omakase-desc]"),
        capacity: document.querySelector("[data-omakase-capacity]"),
        status: document.querySelector("[data-omakase-status]"),
        preview: document.querySelector("[data-omakase-preview]"),
        confirm: document.querySelector("[data-omakase-confirm]"),
    };

    var omakaseMode = "all"; // "all" 전체 부족 품목 | "manifest" 매니페스트에 담긴 품목
    var omakaseResult = null;

    /**
     * 두 진입점의 유일한 차이 — 후보 풀을 어디서 뽑는지.
     * 상한은 둘 다 "부족분 전체"로 같다: 매니페스트를 최적화한다고 해서 원래 필요한
     * 양보다 더 담을 이유는 없다.
     */
    function omakaseCandidates() {
        var pool = omakaseMode === "manifest" ? state.items.filter(included) : state.items.filter(isShort);
        return pool.map(function (item) {
            return { item: item, maxQty: deficit(item) };
        });
    }

    function setOmakaseStatus(text, tone) {
        omakaseModal.status.textContent = text || "";
        if (tone) omakaseModal.status.setAttribute("data-tone", tone);
        else omakaseModal.status.removeAttribute("data-tone");
    }

    function openOmakase(mode) {
        omakaseMode = mode;
        omakaseResult = null;

        var candidates = omakaseCandidates();
        if (!candidates.length) {
            toast(mode === "manifest" ? "매니페스트가 비어 있습니다." : "부족한 품목이 없습니다.", "warn");
            return;
        }

        omakaseModal.title.textContent = mode === "manifest" ? "질량 최적화" : "자동 계산";
        omakaseModal.desc.textContent =
            mode === "manifest"
                ? "매니페스트에 담긴 품목만 대상으로, 적재량에 맞춰 다시 채웁니다."
                : "부족한 전체 품목 중에서 급한 순으로 적재량에 맞춰 채웁니다.";

        omakaseModal.capacity.value = "";
        omakaseModal.preview.textContent = "";
        omakaseModal.confirm.disabled = true;
        setOmakaseStatus("함선 적재량을 입력하세요.");

        omakaseModal.root.showModal();
        omakaseModal.capacity.focus();
    }

    function recomputeOmakase() {
        var cap = parseFloat(omakaseModal.capacity.value);
        omakaseModal.preview.textContent = "";

        if (!cap || cap <= 0) {
            omakaseResult = null;
            omakaseModal.confirm.disabled = true;
            setOmakaseStatus("함선 적재량을 입력하세요.");
            return;
        }

        omakaseResult = omakase(omakaseCandidates(), cap);

        omakaseResult.picks.forEach(function (p) {
            var li = document.createElement("li");
            li.className = "diff__row";
            var name = document.createElement("span");
            name.className = "diff__name";
            name.textContent = p.item.name;
            var qty = document.createElement("span");
            qty.className = "diff__change diff__to";
            qty.textContent = num(p.qty) + "개";
            li.appendChild(name);
            li.appendChild(qty);
            omakaseModal.preview.appendChild(li);
        });

        var pct = cap > 0 ? Math.round((omakaseResult.usedVolume / cap) * 100) : 0;
        setOmakaseStatus(
            num(omakaseResult.picks.length) +
                "개 품목 · " +
                volume(omakaseResult.usedVolume) +
                " / " +
                volume(cap) +
                " m³ (" +
                pct +
                "%)" +
                (omakaseResult.skipped.length
                    ? " · " + num(omakaseResult.skipped.length) + "개는 공간이 부족해 제외"
                    : "")
        );
        omakaseModal.confirm.disabled = omakaseResult.picks.length === 0;
    }

    function commitOmakase() {
        if (!omakaseResult || !omakaseResult.picks.length) return;

        if (omakaseMode === "manifest") {
            // "이 적재량에 맞춘 목록"이 목적이므로, 이번에 뽑히지 않은 기존 품목은 뺀다.
            // 남겨 두면 최적화가 아니라 그냥 추가가 되어 버린다.
            var pickedItems = omakaseResult.picks.map(function (p) {
                return p.item;
            });
            state.items.filter(included).forEach(function (item) {
                if (pickedItems.indexOf(item) === -1) applyInclusion(item, false);
            });
        }

        omakaseResult.picks.forEach(function (p) {
            applyInclusion(p.item, true);
            setManifestQty(p.item, p.qty);
        });

        var count = omakaseResult.picks.length;
        omakaseModal.root.close();
        render();
        toast(
            omakaseMode === "manifest"
                ? "질량에 맞춰 " + num(count) + "개로 다시 채웠습니다."
                : num(count) + "개를 매니페스트에 담았습니다."
        );
    }

    omakaseModal.capacity.addEventListener("input", recomputeOmakase);
    omakaseModal.confirm.addEventListener("click", commitOmakase);
    document.querySelectorAll("[data-omakase-cancel]").forEach(function (b) {
        b.addEventListener("click", function () {
            omakaseModal.root.close();
        });
    });
    omakaseModal.root.addEventListener("click", function (e) {
        if (e.target === omakaseModal.root) omakaseModal.root.close();
    });

    document.querySelector("[data-auto-calc]").addEventListener("click", function () {
        openOmakase("all");
    });
    document.querySelector("[data-manifest-optimize]").addEventListener("click", function () {
        openOmakase("manifest");
    });

    /* ── 토스트 ─────────────────────────────────────────── */

    function copyManifest() {
        var text = manifestText();
        if (!text) return;

        function fallback() {
            // 클립보드 API는 보안 컨텍스트(https / localhost)에서만 동작한다.
            // 매니페스트가 표(아이콘·입력 요소 포함)라 DOM 선택으로는 "이름<TAB>수량"이
            // 깨끗하게 안 나온다 — 순수 텍스트만 담은 숨김 textarea 를 선택한다.
            var ta = document.createElement("textarea");
            ta.value = text;
            ta.setAttribute("readonly", "");
            ta.className = "vh";
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            setTimeout(function () {
                document.body.removeChild(ta);
            }, 4000);
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
            el.tablewrap.scrollTop = 0; // 목록 구성 자체가 바뀌니 위로 되돌린다.
            render();
        });
    });

    el.query.addEventListener("input", function () {
        state.query = el.query.value;
        el.tablewrap.scrollTop = 0;
        render();
    });

    if (el.hangar) {
        el.hangar.addEventListener("change", function () {
            if (el.hangar.value && el.hangar.value !== state.structureId) {
                loadStructureData(el.hangar.value);
            }
        });
    }

    if (el.division) {
        el.division.addEventListener("change", function () {
            // 첫 "::"에서만 자른다 — 컨테이너 이름 자체에 "::"가 들어있어도(admin이
            // /재고행어설정으로 그렇게 지었다면) division 뒤 나머지 전부가 container로
            // 온전히 남는다.
            var raw = el.division.value;
            var sepIdx = raw.indexOf("::");
            var divisionPart = sepIdx === -1 ? raw : raw.slice(0, sepIdx);
            var containerPart = sepIdx === -1 ? "" : raw.slice(sepIdx + 2);
            state.division = divisionPart ? Number(divisionPart) : null;
            state.container = containerPart || null;
            if (state.structureId) loadStockData(state.structureId);
        });
    }

    // 정렬은 전부 표 헤더 클릭으로 한다 — 드롭다운은 필터가 두 군데로 나뉘던 걸 합치며 없앴다.
    var ASC_DEFAULT_SORT_KEYS = ["days", "ratio", "name", "stocked"];

    function setSortKey(key) {
        if (state.sort.key === key) {
            // 이미 그 기준으로 보고 있으면 다시 눌렀을 때 방향만 뒤집는다.
            state.sort.asc = !state.sort.asc;
        } else {
            state.sort.key = key;
            // 축을 바꾸면 그 축에서 "유용한 쪽"을 기본으로 잡는다. 소진 예상일·부족률·
            // 이름·보유량은 적은/급한 쪽이 앞에 와야 하고, 나머지는 큰 쪽이 눈에 띈다.
            state.sort.asc = ASC_DEFAULT_SORT_KEYS.indexOf(key) !== -1;
        }
        renderSortDir();
        render();
    }

    document.querySelectorAll("[data-sort-key]").forEach(function (btn) {
        btn.addEventListener("click", function () {
            setSortKey(btn.getAttribute("data-sort-key"));
        });
    });

    el.sortDir.addEventListener("click", function () {
        state.sort.asc = !state.sort.asc;
        renderSortDir();
        render();
    });

    // 가상 스크롤: 스크롤 위치가 바뀔 때마다 화면에 보이는 구간만 다시 그린다.
    // rAF로 묶어서 빠르게 휠을 굴려도 프레임당 한 번만 다시 그리게 한다.
    var scrollFrame = null;
    el.tablewrap.addEventListener("scroll", function () {
        if (scrollFrame) return;
        scrollFrame = requestAnimationFrame(function () {
            scrollFrame = null;
            renderWindow();
        });
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

    modal.fittingToggle.addEventListener("click", function () {
        var open = modal.fittingItems.hidden;
        modal.fittingItems.hidden = !open;
        modal.fittingToggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    modal.fittingEdit.addEventListener("click", function () {
        if (openItem) openFittingModal(openItem);
    });
    modal.fittingDelete.addEventListener("click", function () {
        if (openItem) deleteFitting(openItem);
    });
    fittingModal.check.addEventListener("click", checkFittingText);
    fittingModal.confirm.addEventListener("click", commitFitting);
    document.querySelectorAll("[data-fitting-cancel]").forEach(function (b) {
        b.addEventListener("click", function () {
            fittingModal.root.close();
        });
    });

    // 백드롭 클릭으로 닫기
    [saveModal.root, addModal.root, fittingModal.root].forEach(function (d) {
        d.addEventListener("click", function (e) {
            if (e.target === d) d.close();
        });
    });

    /* ── 인증 + 시작 ────────────────────────────────────── */

    // nextSyncAt(백엔드가 ESI Expires 헤더로 구조물별로 잡는 실제 다음 동기화 시각)을
    // 몰랐을 때만 쓰는 폴백 — 예전 고정 1시간 주기와 같은 값이라 몰라도 예전보다
    // 나빠지지 않는다.
    var AUTO_REFRESH_FALLBACK_MS = 60 * 60 * 1000;
    // nextSyncAt 직후 살짝 여유(백엔드가 그 시각에 동기화를 "시작"하는 거지 그 전에
    // 이미 끝나 있다는 보장이 없어서, 너무 딱 맞춰 부르면 갱신 전 데이터를 받을 수 있음).
    var AUTO_REFRESH_BUFFER_MS = 15 * 1000;
    // nextSyncAt이 이미 지났거나 아주 가까워도 너무 촉박하게 다시 부르지 않게 하는 하한.
    var AUTO_REFRESH_MIN_MS = 30 * 1000;
    var refreshTimerId = null;

    /**
     * 다음 자동 새로고침을 예약한다. loadStockData가 매번 응답의 nextSyncAt으로
     * 다시 호출하는 자기갱신 체인이라 별도 setInterval이 없다 — 수동으로 행어/필터를
     * 바꿔도 그 즉시 loadStockData가 다시 불리면서 최신 nextSyncAt 기준으로 재조정된다.
     * @param {string|null} nextSyncAtIso
     */
    function scheduleAutoRefresh(nextSyncAtIso) {
        if (refreshTimerId) clearTimeout(refreshTimerId);
        var delay = AUTO_REFRESH_FALLBACK_MS;
        if (nextSyncAtIso) {
            var untilNext = new Date(nextSyncAtIso).getTime() - Date.now() + AUTO_REFRESH_BUFFER_MS;
            delay = Math.max(AUTO_REFRESH_MIN_MS, untilNext);
        }
        refreshTimerId = setTimeout(function () {
            if (!state.structureId) return;
            loadStockData(state.structureId);
            // loadStockData와 별개로 같이 돈다 — 자동 새로고침 사이에 피팅이
            // 추가/수정/삭제됐으면(다른 관리자가 했을 수도 있음) 매니페스트 합계가
            // 다음 수동 조작 전까지 계속 옛 피팅 기준으로 남는 걸 막는다.
            loadFittings(state.structureId).then(render);
        }, delay);
    }

    /** authError 쿼리 파라미터(/auth/consume이 실패 시 여기로 리다이렉트하며 붙임). */
    function authErrorMessage() {
        var code = new URLSearchParams(window.location.search).get("authError");
        if (code === "expired_link") {
            return "로그인 링크가 만료됐거나 이미 사용됐습니다. Discord에서 /보급 명령으로 새 링크를 받아주세요.";
        }
        if (code === "missing_token") {
            return "로그인 링크가 올바르지 않습니다. Discord에서 /보급 명령으로 새 링크를 받아주세요.";
        }
        return null;
    }

    function showAuthGate(message) {
        if (message && el.authgateMsg) el.authgateMsg.textContent = message;
        if (el.authgate) el.authgate.hidden = false;
    }

    function init() {
        var authErrorMsg = authErrorMessage();

        window.BonsaiApi.checkAuth().then(function (auth) {
            if (!auth.ok) {
                showAuthGate(authErrorMsg);
                return;
            }

            setupHub();
            setupLangToggle();
            renderSortDir();

            window.BonsaiApi.fetchStructures()
                .then(function (structures) {
                    if (!structures.length) {
                        showAuthGate("등록된 구조물이 없습니다. 관리자에게 문의해주세요.");
                        return;
                    }
                    setupHangarSelect(structures);
                    return loadStructureData(el.hangar.value);
                })
                .then(function () {
                    loadPrices();
                    // 자동 새로고침은 loadStockData 안 scheduleAutoRefresh가 매번 응답의
                    // nextSyncAt으로 스스로 다시 예약한다 — loadStructureData가 이미 위에서
                    // loadStockData를 한 번 불렀으니 여기서 별도로 시작할 필요가 없다.
                })
                .catch(function (err) {
                    toast(err.message || "재고를 불러오지 못했습니다.", "warn");
                });
        });
    }

    init();
})();
