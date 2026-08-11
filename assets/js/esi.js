/**
 * ESI 이름 해석.
 *
 * 브라우저에서 직접 친다. `/universe/ids/` 는 인증이 없고 프리플라이트도 통과한다
 * (OPTIONS 204 + `Access-Control-Allow-Origin: *`, POST 와 content-type 허용) — 직접 확인함.
 *
 * 백엔드에 저장 요청을 보내기 전에 "실재하는 아이템인지"를 미리 걸러내는 용도다.
 * 최종 검증은 여전히 백엔드 몫이다 — 프론트 검사는 사용자가 오타를 빨리 알아채게 할 뿐,
 * 신뢰 경계가 아니다.
 */
(function () {
    "use strict";

    var ENDPOINT = "https://esi.evetech.net/latest/universe/ids/";
    // 한 번에 보낼 수 있는 이름 수. ESI 문서상 상한이 있어 넉넉히 잘라 보낸다.
    var CHUNK = 200;

    /**
     * 인게임에서 복사한 텍스트를 파싱한다.
     *
     * 붙여넣기 형태는 "이름<TAB>수량" 이고, 이름 끝에 별표가 붙어 오는 경우가 있다.
     * 별표를 달고 보내면 ESI 가 하나도 못 찾으므로(실측 0/2) 반드시 떼야 한다.
     * 수동 입력은 이름만 있을 수도 있다.
     *
     * @returns {Array<{name: string, qty: number|null}>}
     */
    function parseLines(text) {
        var seen = Object.create(null);
        var out = [];

        String(text || "")
            .split(/\r?\n/)
            .forEach(function (raw) {
                var line = raw.trim();
                if (!line) return;

                // 탭이 우선이고, 없으면 줄 끝의 숫자를 수량으로 본다.
                var name = line;
                var qty = null;
                var tab = line.split("\t");
                if (tab.length > 1) {
                    name = tab[0];
                    qty = parseInt(String(tab[1]).replace(/[,\s]/g, ""), 10);
                } else {
                    var m = line.match(/^(.*?)[\s]{2,}([\d,]+)$/) || line.match(/^(.*?)\s+([\d,]+)$/);
                    if (m) {
                        name = m[1];
                        qty = parseInt(m[2].replace(/,/g, ""), 10);
                    }
                }

                name = name.replace(/\*+$/, "").trim(); // 인게임 복사본의 별표
                if (!name) return;
                if (isNaN(qty)) qty = null;

                var key = name.toLowerCase();
                if (seen[key]) return; // 같은 줄이 두 번 오면 앞의 것만
                seen[key] = true;
                out.push({ name: name, qty: qty });
            });

        return out;
    }

    function chunk(list, size) {
        var out = [];
        for (var i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
        return out;
    }

    function postNames(names, language) {
        return fetch(ENDPOINT + "?language=" + language, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(names),
        }).then(function (r) {
            if (!r.ok) throw new Error("ESI " + r.status);
            return r.json();
        });
    }

    /**
     * 이름 목록을 typeId 로 바꾼다.
     *
     * 한글·영문 클라이언트를 모두 받아야 하는데 ESI 는 언어를 지정해야만 찾는다 —
     * language 없이 한글 이름을 보내면 0개가 나온다(실측). 그래서 두 언어로 동시에 던지고
     * 먼저 맞는 쪽을 쓴다. 목록에 두 언어가 섞여 있어도 이 방식이면 각각 걸린다.
     *
     * @param {string[]} names
     * @returns {Promise<{found: Object<string, {id:number, name:string, language:string}>, missing: string[]}>}
     *          found 의 키는 입력한 이름을 소문자로 바꾼 값이다.
     */
    function resolveNames(names) {
        if (!names.length) return Promise.resolve({ found: {}, missing: [] });

        var jobs = [];
        chunk(names, CHUNK).forEach(function (part) {
            ["ko", "en"].forEach(function (lang) {
                jobs.push(
                    postNames(part, lang).then(
                        function (d) {
                            return { lang: lang, types: d.inventory_types || [] };
                        },
                        function () {
                            // 한쪽 언어가 실패해도 다른 쪽 결과는 쓴다.
                            return { lang: lang, types: [] };
                        }
                    )
                );
            });
        });

        return Promise.all(jobs).then(function (results) {
            var byName = Object.create(null);
            results.forEach(function (r) {
                r.types.forEach(function (t) {
                    var key = String(t.name).toLowerCase();
                    if (!byName[key]) byName[key] = { id: t.id, name: t.name, language: r.lang };
                });
            });

            var found = Object.create(null);
            var missing = [];
            names.forEach(function (n) {
                var key = String(n).toLowerCase();
                if (byName[key]) found[key] = byName[key];
                else missing.push(n);
            });
            return { found: found, missing: missing };
        });
    }

    window.BonsaiEsi = { parseLines: parseLines, resolveNames: resolveNames };
})();
