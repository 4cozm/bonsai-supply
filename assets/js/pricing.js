/**
 * 시세 조회 어댑터.
 *
 * **가짜 숫자를 채우지 않는다.** 예전엔 typeId 가 없거나 조회가 실패한 품목을 그럴듯한
 * 목업 숫자로 채워 "자릿수 감각"만 남기려 했는데, 시세는 계속 바뀌는 값이라 그 숫자가
 * 진짜처럼 보이면 사용자가 그걸 근거로 판단할 수 있다 — 없으면 없다고 보이는 게 맞다.
 * 그래서 값을 모르는 품목은 unitPrices 에서 아예 키를 뺀다. 화면은 그 경우 기존 규칙대로
 * "—" 를 보여 준다(app.js 의 isk() 참고). 실패 자체는 source 문자열과 ok 플래그로
 * 눈에 띄게 알린다 — app.js 가 이걸로 상단 표시를 경고 톤으로 바꾼다.
 *
 * Fuzzwork market aggregates 를 쓴다. 실측으로 확인했다:
 *
 *   GET https://market.fuzzwork.co.uk/aggregates/?station=60003760&types=2456,2488,...
 *   Access-Control-Allow-Origin: *      ← 있음, 키 불필요
 *
 * typeId 를 콤마로 이어 **한 번에 배치 조회**한다 — 개별 typeId 마다 따로 부르면 429
 * (레이트리밋)를 벌기 딱 좋다. 15개를 한 번에 받는 데 1.2초, 6KB(실측). station=60003760은
 * Jita IV-4 CNAP — 이 앱이 다루는 물류 기준점과 일치한다. 값은 `sell.percentile`을 쓴다 —
 * 상/하위 이상치를 걸러낸 값이라 최저/최고가보다 시세 조작에 덜 흔들린다.
 *
 * Janice는 후보에서 뺐다. `Access-Control-Allow-Origin` 헤더가 아예 없어 브라우저에서
 * 못 치고, API 키가 Discord DM 으로 받는 개인 발급이라 정적 프론트에 박아 두면 방문자
 * 전원이 그 키를 보게 된다.
 *
 * Fuzzwork 이 실패하면 ESI `/markets/prices/` 로 폴백한다. EVE Tycoon·adam4eve 도 실측
 * 해 봤는데 응답은 오지만 `Access-Control-Allow-Origin` 이 없어 브라우저에서 못 읽는다.
 * EVE Ref 의 시장 데이터는 리전 전체 주문서를 통째로 덤프하는 파일이라(30분마다 스크랩)
 * 품목 몇 개 가격 받자고 쓸 도구가 아니다. ESI 는 CORS 가 열려 있고 CCP 공식이라 이
 * 셋보다 안 죽을 가능성이 높으며, 요청 한 번에 게임 전체 가격이 다 온다(배치할 필요가
 * 아예 없다).
 *
 * 다만 이 값은 성격이 다르다 — Fuzzwork 의 `sell.percentile` 은 "지금 지타에서 제일 싼
 * 매도 호가"지만, ESI 의 `average_price` 는 매끄럽게 평균낸 값이라 실시간 거래가와
 * 다르다. 그래서 같은 방식으로 조용히 채우면 이 파일 맨 위에서 말한 원칙("모르는 값을
 * 그럴듯하게 채우지 않는다")을 또 어기게 된다. source 문자열과 별도의 approx 플래그로
 * "이 숫자는 다른 종류"라는 걸 표시하고, app.js 가 이걸로 단가 줄에 물결표(~)를 붙인다.
 */
(function () {
    "use strict";

    var FUZZWORK_URL = "https://market.fuzzwork.co.uk/aggregates/";
    var ESI_PRICES_URL = "https://esi.evetech.net/latest/markets/prices/?datasource=tranquility";

    // 4대 상권. station id 는 ESI /universe/stations/{id}/ 로 실측 검증했고, Fuzzwork
    // aggregates 가 넷 다 실제로 다른 값을 주는 것도 확인했다(Hobgoblin II 매도가:
    // 지타 325,818 / 아마르 326,742 / 도딕시 349,697 / 렌즈 341,500). id 의 유일한
    // 출처는 여기다 — index.html 의 <select> 는 이 목록을 그대로 그려 넣는다.
    var HUBS = [
        { id: 60003760, name: "지타" },
        { id: 60008494, name: "아마르" },
        { id: 60011866, name: "도딕시" },
        { id: 60004588, name: "렌즈" },
    ];
    var DEFAULT_HUB = HUBS[0];

    function hubById(id) {
        for (var i = 0; i < HUBS.length; i++) {
            if (HUBS[i].id === id) return HUBS[i];
        }
        return DEFAULT_HUB;
    }

    /**
     * ESI 전체 가격 목록 폴백. 응답이 15,890개 전 품목을 한 번에 담고 있어 typeId 별로
     * 나눠 부를 필요가 없다 — station 파라미터가 없다(지역 시장 개념이 아니라 게임 전체
     * 기준 참고값이라서). average_price 를 쓴다: adjusted_price 는 보험금 산정용이라
     * "얼마면 살 수 있나"라는 이 화면의 질문과 더 멀다.
     *
     * hub 를 무시한다 — 애초에 상권별 값이 없는 폴백이라 지타를 고르든 렌즈를 고르든
     * 같은 숫자가 나온다. source 문자열에 그 사실을 적어 둔다 — 안 적으면 사용자가
     * "렌즈 기준"이라고 착각한 채 이 값을 볼 수 있다.
     */
    function esiFallbackProvider(items) {
        var priced = items.filter(function (i) {
            return i.typeId > 0;
        });
        if (!priced.length) {
            return Promise.resolve({
                source: "가격 조회 대상 없음",
                ok: true,
                approx: false,
                pricedAt: new Date(),
                unitPrices: {},
            });
        }

        return fetch(ESI_PRICES_URL)
            .then(function (r) {
                if (!r.ok) throw new Error("ESI " + r.status);
                return r.json();
            })
            .then(function (rows) {
                var byType = {};
                rows.forEach(function (row) {
                    if (row.average_price) byType[row.type_id] = row.average_price;
                });

                var prices = {};
                var missing = 0;
                priced.forEach(function (item) {
                    var p = byType[item.typeId];
                    if (!p) {
                        missing++;
                        return;
                    }
                    prices[item.name] = p;
                });

                return {
                    source:
                        "ESI 평균가(참고용, 실시간·상권 무관)" +
                        (missing ? " · " + missing + "개 가격 없음" : ""),
                    ok: true,
                    approx: true,
                    pricedAt: new Date(),
                    unitPrices: prices,
                };
            });
    }

    function fuzzworkProvider(items, hubId) {
        var hub = hubById(hubId);
        var priced = items.filter(function (i) {
            return i.typeId > 0;
        });
        var unpricedCount = items.length - priced.length;

        if (!priced.length) {
            return Promise.resolve({
                source: "가격 조회 대상 없음",
                ok: true,
                approx: false,
                pricedAt: new Date(),
                unitPrices: {},
            });
        }

        // typeId 는 중복될 수 없지만, 같은 typeId 를 가리키는 로컬 품목이 두 개면(이론상)
        // 응답 하나를 여러 이름에 매핑해야 하므로 typeId → 이름 배열로 모아 둔다.
        var namesByType = {};
        priced.forEach(function (item) {
            (namesByType[item.typeId] = namesByType[item.typeId] || []).push(item.name);
        });
        var typeIds = Object.keys(namesByType);
        var url = FUZZWORK_URL + "?station=" + hub.id + "&types=" + typeIds.join(",");

        return fetch(url)
            .then(function (r) {
                if (!r.ok) throw new Error("Fuzzwork " + r.status);
                return r.json();
            })
            .then(function (data) {
                var prices = {};
                var noQuote = 0;
                typeIds.forEach(function (id) {
                    var row = data[id];
                    var p = row && row.sell && parseFloat(row.sell.percentile);
                    if (!p) {
                        noQuote++; // 매도 호가가 없는(비유동적인) 품목 — 값을 지어내지 않는다
                        return;
                    }
                    namesByType[id].forEach(function (name) {
                        prices[name] = p;
                    });
                });

                var missing = unpricedCount + noQuote;
                return {
                    source: "Fuzzwork(" + hub.name + " 매도)" + (missing ? " · " + missing + "개 가격 없음" : ""),
                    ok: true,
                    approx: false,
                    pricedAt: new Date(),
                    unitPrices: prices,
                };
            });
    }

    window.BonsaiPricing = {
        /** 상단 상권 셀렉트를 채우는 유일한 출처. 이름·ID를 다른 곳에 또 적지 않는다. */
        HUBS: HUBS,
        DEFAULT_HUB_ID: DEFAULT_HUB.id,

        /**
         * @param {Array<{name: string, typeId: number, unitVolume: number}>} items
         * @param {number} [hubId] 4대 상권 station id. 생략하면 지타.
         * @returns {Promise<{source: string, ok: boolean, approx: boolean, pricedAt: Date|null, unitPrices: Record<string, number>}>}
         *          unitPrices 는 품목명 → 개당 ISK. 값을 모르는 품목은 키가 아예 없다
         *          (0 이 아니다) — 화면은 이를 "—" 로 보여 준다.
         *          approx 가 true 면 실시간 매도가가 아니라 ESI 평균값 폴백이 쓰였다는
         *          뜻이다(이 폴백은 상권을 구분하지 않는다) — app.js 가 이걸로 단가
         *          표시에 물결표를 붙인다.
         *          ok 가 false 면 Fuzzwork·ESI 폴백 둘 다 실패한 것이고 unitPrices 는
         *          비어 있다. 그 경우 이전에 받아 둔 값을 지울지는 호출부(app.js)가 정한다.
         */
        fetchPrices: function (items, hubId) {
            return fuzzworkProvider(items, hubId).catch(function () {
                return esiFallbackProvider(items).catch(function (err) {
                    return {
                        source: "가격 조회 실패" + (err && err.message ? " (" + err.message + ")" : ""),
                        ok: false,
                        approx: false,
                        pricedAt: null,
                        unitPrices: {},
                    };
                });
            });
        },
    };
})();
