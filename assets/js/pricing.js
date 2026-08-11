/**
 * 시세 조회 어댑터.
 *
 * 정적 사이트에서 브라우저가 서드파티 시세 API를 직접 호출하려면 두 가지가 성립해야 한다.
 * 둘 다 아직 확인되지 않았고, 어느 쪽이 막히면 백엔드 프록시가 필요해진다.
 *
 *   1. CORS — 응답에 우리 origin을 허용하는 헤더가 있어야 한다. 없으면 브라우저가 막는다.
 *   2. 레이트리밋 — 호출이 사용자 브라우저마다 따로 나간다. 서버 한 곳에서 나가는 게 아니다.
 *
 * 그래서 지금은 provider 하나만 갈아끼우면 되도록 경계를 만들어 두고, mock 을 물려 놨다.
 *
 * 후보:
 *   - Fuzzwork market aggregates — typeId 단위로 Jita 4-4(station 60003760) 매수/매도 집계를
 *     돌려준다. 키가 없고 typeId 기반이라 품목별 단가를 붙이기에 가장 잘 맞는다.
 *   - Janice — 매니페스트 텍스트를 통째로 넣고 감정(appraisal) 결과를 받는 방식. API 키가 필요하다.
 *     키가 필요하다는 건 정적 프론트에 둘 수 없다는 뜻이므로, 쓰려면 백엔드 경유가 강제된다.
 *
 * 어느 쪽이든 실제 붙이기 전에 CORS 동작을 직접 확인해야 한다.
 */
(function () {
    "use strict";

    /**
     * 목업 provider. typeId가 아직 0이라 이름을 시드로 삼아 안정적인 값을 만든다.
     * 실제 시세가 아니며, 자릿수 감각만 맞춘 값이다.
     */
    function mockProvider(items) {
        function seedOf(name) {
            var h = 2166136261;
            for (var i = 0; i < name.length; i++) {
                h ^= name.charCodeAt(i);
                h = Math.imul(h, 16777619);
            }
            return (h >>> 0) / 4294967296;
        }

        var prices = {};
        items.forEach(function (item) {
            var r = seedOf(item.name);
            // 부피가 큰 물건은 대체로 비싸다 — 함선과 탄약의 자릿수를 갈라 놓기 위한 근사.
            var base = item.unitVolume >= 1000 ? 180e6 : item.unitVolume >= 1 ? 8e5 : 90;
            prices[item.name] = Math.round(base * (0.55 + r * 0.9));
        });

        return Promise.resolve({
            source: "목업",
            pricedAt: null,
            unitPrices: prices,
        });
    }

    window.BonsaiPricing = {
        /**
         * @param {Array<{name: string, typeId: number, unitVolume: number}>} items
         * @returns {Promise<{source: string, pricedAt: Date|null, unitPrices: Record<string, number>}>}
         *          unitPrices 는 품목명 → 개당 Jita 매도가(ISK). 값이 없는 품목은 키가 없다.
         */
        fetchPrices: function (items) {
            return mockProvider(items);
        },
    };
})();
