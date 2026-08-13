/**
 * bonsai-bot-v2 API 클라이언트.
 *
 * 세션은 httpOnly 쿠키(bonsai_session)로 관리된다 — 로그인은 Discord `/보급`
 * 명령이 발급하는 매직링크로만 하고, 이 파일은 그 쿠키를 매 요청에 자동으로
 * 실어 보내는(credentials:"include") 것 말고는 인증에 관여하지 않는다.
 *
 * API 서버가 다른 오리진(api.catalyst-for-you.com)이라 모든 요청이 크로스오리진
 * fetch다 — credentials:"include" 없으면 쿠키가 안 실리고, 서버 쪽 CORS가
 * Access-Control-Allow-Credentials:true + 정확한 origin(와일드카드 불가)이어야
 * 브라우저가 응답을 통과시킨다(서버는 이미 그렇게 설정돼 있음).
 */
(function () {
    "use strict";

    var API_BASE = "https://api.catalyst-for-you.com";

    function get(path) {
        return fetch(API_BASE + path, { credentials: "include" }).then(function (r) {
            return r.json().then(
                function (body) {
                    return { status: r.status, ok: r.ok, body: body };
                },
                function () {
                    // 401 등은 body가 없을 수도 있다(예: /auth/me 401은 body 없음).
                    return { status: r.status, ok: r.ok, body: null };
                }
            );
        });
    }

    function patch(path, body) {
        return fetch(API_BASE + path, {
            method: "PATCH",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        }).then(function (r) {
            return r.json().then(
                function (respBody) {
                    return { status: r.status, ok: r.ok, body: respBody };
                },
                function () {
                    return { status: r.status, ok: r.ok, body: null };
                }
            );
        });
    }

    /**
     * 로그인 여부 확인. 세션이 없거나 만료됐으면 ok:false만 온다(에러가 아니라
     * 정상적으로 나올 수 있는 상태).
     * @returns {Promise<{ok:boolean, discordId?:string, tenantKey?:string}>}
     */
    function checkAuth() {
        return get("/auth/me").then(function (res) {
            if (!res.ok) return { ok: false };
            return res.body;
        });
    }

    /** @returns {Promise<{structureId:string, displayName:string}[]>} */
    function fetchStructures() {
        return get("/v1/stock/structures").then(function (res) {
            if (!res.ok) throw new Error("구조물 목록 조회 실패 (HTTP " + res.status + ")");
            return res.body.structures;
        });
    }

    /**
     * 이 구조물에 설정된 추적 대상 행어/컨테이너 목록(관리자가 /재고행어설정으로
     * 등록한 것만) — 행어 선택 UI를 채우는 유일한 출처. 한글 행어 이름을 여기 말고
     * 다른 곳에 하드코딩하지 않는다.
     * @param {string} structureId
     * @returns {Promise<{division:number, containerName:string|null, displayName:string}[]>}
     */
    function fetchDivisions(structureId) {
        return get("/v1/stock/structures/" + encodeURIComponent(structureId) + "/divisions").then(
            function (res) {
                if (!res.ok) throw new Error("행어 목록 조회 실패 (HTTP " + res.status + ")");
                return res.body.divisions;
            }
        );
    }

    /**
     * @param {string} structureId
     * @param {{division?:number, container?:string}} [filter] 생략하면 구조물 전체.
     * @returns {Promise<{structure:object, items:Array}>}
     */
    function fetchStockItems(structureId, filter) {
        var path = "/v1/stock/structures/" + encodeURIComponent(structureId) + "/items";
        var params = [];
        if (filter && filter.division != null) {
            params.push("division=" + encodeURIComponent(filter.division));
            if (filter.container) params.push("container=" + encodeURIComponent(filter.container));
        }
        if (params.length) path += "?" + params.join("&");

        return get(path).then(function (res) {
            if (!res.ok) throw new Error("재고 조회 실패 (HTTP " + res.status + ")");
            return res.body;
        });
    }

    /**
     * @param {string} structureId
     * @param {number} typeId
     * @param {number} days
     * @param {string|null} [itemName] 함선처럼 개별 이름이 있는 품목이면 그 이름만
     *        걸러서 조회한다 — 생략하면(일반 품목) 필터 없이 typeId 전체 이력.
     * @returns {Promise<{typeId:number, days:number, history:Array}>}
     */
    function fetchItemHistory(structureId, typeId, days, itemName) {
        var path =
            "/v1/stock/structures/" +
            encodeURIComponent(structureId) +
            "/items/" +
            encodeURIComponent(typeId) +
            "/history?days=" +
            encodeURIComponent(days);
        if (itemName) path += "&itemName=" + encodeURIComponent(itemName);

        return get(path).then(function (res) {
            if (!res.ok) throw new Error("이력 조회 실패 (HTTP " + res.status + ")");
            return res.body;
        });
    }

    /**
     * 목표 수량 저장/삭제. targetQty<=0이면 서버가 목표 자체를 지운다("목표없음"
     * 상태로 되돌림 — app.js의 hasNoTarget()이 target=0을 다루는 방식과 대응).
     * @param {string} structureId
     * @param {{typeId:number, itemName?:string|null, targetQty:number}} payload
     * @returns {Promise<void>}
     */
    function saveTarget(structureId, payload) {
        return patch(
            "/v1/stock/structures/" + encodeURIComponent(structureId) + "/targets",
            payload
        ).then(function (res) {
            if (!res.ok) throw new Error("목표 저장 실패 (HTTP " + res.status + ")");
        });
    }

    window.BonsaiApi = {
        API_BASE: API_BASE,
        checkAuth: checkAuth,
        fetchStructures: fetchStructures,
        fetchDivisions: fetchDivisions,
        fetchStockItems: fetchStockItems,
        fetchItemHistory: fetchItemHistory,
        saveTarget: saveTarget,
    };
})();
