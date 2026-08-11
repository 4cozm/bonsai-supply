/**
 * 시세 조회 어댑터.
 *
 * 정적 사이트에서 브라우저가 서드파티 시세 API를 직접 호출하려면 두 가지가 성립해야 했다.
 *
 *   1. CORS — 응답에 우리 origin을 허용하는 헤더가 있어야 한다. 없으면 브라우저가 막는다.
 *   2. 레이트리밋 — 호출이 사용자 브라우저마다 따로 나간다. 서버 한 곳에서 나가는 게 아니다.
 *
 * 두 후보를 실측했다.
 *
 *   - Janice — 매니페스트를 통째로 감정(appraisal)하는 방식이라 매력적이었지만 탈락.
 *     `Access-Control-Allow-Origin` 헤더가 아예 없어 브라우저에서 못 친다. 게다가 API 키가
 *     Discord DM 으로 받는 개인 발급이고, 본인 이름에 안 묶인 키를 쓰면 예고 없이 차단될
 *     수 있다고 문서에 명시돼 있다 — 정적 프론트에 박아 두면 방문자 전원이 그 키를 보게
 *     되므로 애초에 쓸 수 없는 방식이다.
 *   - Fuzzwork market aggregates — `Access-Control-Allow-Origin: *` 확인됨, 키 불필요.
 *     typeId 를 콤마로 이어 한 번에 배치 조회된다(15개 응답 1.2초, 6KB). station=60003760 은
 *     Jita IV-4 CNAP, 이 앱이 다루는 물류 기준점과 일치한다.
 *
 * CCP 공식이 아닌 커뮤니티 서비스라 SLA 는 없다. 그래서 fetchPrices() 실패 시 이전에
 * 받아 둔 가격을 그대로 두고 조용히 넘어간다 — 시세 갱신 실패로 매니페스트가 못 쓰게
 * 되면 안 된다. 목업 provider 는 그대로 남겨 뒀다: typeId 가 아직 없는 로컬 추가 품목이나,
 * Fuzzwork 이 죽었을 때의 폴백으로 쓴다.
 */
(function () {
    "use strict";

    var FUZZWORK_URL = "https://market.fuzzwork.co.uk/aggregates/";
    var JITA_4_4_STATION = 60003760;

    /**
     * 목업 provider. typeId가 없는 품목(로컬로만 추가돼 아직 백엔드 확정 전인 경우)이나
     * 실 시세 조회가 실패했을 때의 폴백이다. 이름을 시드로 삼아 안정적인 값을 만들 뿐
     * 실제 시세가 아니다 — 자릿수 감각만 맞춘다.
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

    /**
     * Fuzzwork market aggregates. typeId 가 있는 품목만 실가 조회하고, 없는 품목은
     * 목업으로 채워 자릿수 감각이라도 남긴다 — 표 전체가 "—"로 비는 것보다 낫다.
     */
    function fuzzworkProvider(items) {
        var priced = items.filter(function (i) {
            return i.typeId > 0;
        });
        var unpriced = items.filter(function (i) {
            return !(i.typeId > 0);
        });

        if (!priced.length) return mockProvider(unpriced);

        // typeId 는 중복될 수 없지만, 같은 typeId 를 가리키는 로컬 품목이 두 개면(이론상)
        // 응답 하나를 여러 이름에 매핑해야 하므로 typeId → 이름 배열로 모아 둔다.
        var namesByType = {};
        priced.forEach(function (item) {
            (namesByType[item.typeId] = namesByType[item.typeId] || []).push(item.name);
        });
        var typeIds = Object.keys(namesByType);
        var url = FUZZWORK_URL + "?station=" + JITA_4_4_STATION + "&types=" + typeIds.join(",");

        return fetch(url)
            .then(function (r) {
                if (!r.ok) throw new Error("Fuzzwork " + r.status);
                return r.json();
            })
            .then(function (data) {
                var prices = {};
                typeIds.forEach(function (id) {
                    var row = data[id];
                    // percentile 은 상위/하위 이상치를 걸러낸 실거래 기준값이라 단순 최저/최고가
                    // 보다 조작에 덜 흔들린다 — EVE 시세 도구들이 대체로 이 값을 "시세"로 쓴다.
                    var p = row && row.sell && parseFloat(row.sell.percentile);
                    if (!p) return; // 매도 호가가 없는 품목(비유동적)은 조용히 건너뛴다
                    namesByType[id].forEach(function (name) {
                        prices[name] = p;
                    });
                });

                if (unpriced.length) {
                    return mockProvider(unpriced).then(function (fallback) {
                        return {
                            source: "Fuzzwork(지타 매도)",
                            pricedAt: new Date(),
                            unitPrices: Object.assign({}, fallback.unitPrices, prices),
                        };
                    });
                }
                return { source: "Fuzzwork(지타 매도)", pricedAt: new Date(), unitPrices: prices };
            });
    }

    window.BonsaiPricing = {
        /**
         * @param {Array<{name: string, typeId: number, unitVolume: number}>} items
         * @returns {Promise<{source: string, pricedAt: Date|null, unitPrices: Record<string, number>}>}
         *          unitPrices 는 품목명 → 개당 Jita 매도가(ISK). 값이 없는 품목은 키가 없다.
         */
        fetchPrices: function (items) {
            return fuzzworkProvider(items).catch(function () {
                // Fuzzwork 이 죽었거나 네트워크가 막혔을 때의 마지막 방어선.
                return mockProvider(items);
            });
        },
    };
})();
