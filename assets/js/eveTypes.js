/**
 * typeId → {name, group, unitVolume} 해석.
 *
 * 백엔드는 typeId와 재고 숫자만 안다 — "이 typeId가 실제로 뭔지"는 일부러 여기서
 * 프론트가 공개 ESI에 직접 붙여 해석한다(아이콘도 이미 이 방식이다, app.js의
 * ICON_BASE 참고). ESI 패치로 이름이 바뀌어도 백엔드 캐시 무효화를 신경 쓸 필요가
 * 없어지는 게 이 역할 분리의 이유다.
 *
 * /universe/types/{id}/ 는 typeId 하나당 요청 하나뿐이라(배치 GET이 없음) 로컬에
 * 오래 캐싱해 둔다 — 이름·그룹·부피는 게임 패치가 아니면 사실상 안 바뀐다.
 */
(function () {
    "use strict";

    var ESI_BASE = "https://esi.evetech.net/latest";
    var CACHE_PREFIX = "bonsai:evetype:v1:";
    var GROUP_CACHE_PREFIX = "bonsai:evegroup:v1:";
    var CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30일

    function readCache(key) {
        try {
            var raw = localStorage.getItem(key);
            if (!raw) return null;
            var parsed = JSON.parse(raw);
            if (!parsed || Date.now() - parsed.cachedAt > CACHE_TTL_MS) return null;
            return parsed.value;
        } catch (e) {
            return null;
        }
    }

    function writeCache(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify({ value: value, cachedAt: Date.now() }));
        } catch (e) {
            // localStorage 꽉 찼거나 비활성화 — 캐싱 없이 계속 진행(매번 다시 조회할 뿐).
        }
    }

    function fetchType(typeId) {
        return fetch(ESI_BASE + "/universe/types/" + typeId + "/?datasource=tranquility&language=ko")
            .then(function (r) {
                if (!r.ok) throw new Error("ESI universe/types " + r.status);
                return r.json();
            })
            .then(function (d) {
                return { name: d.name, groupId: d.group_id, unitVolume: d.packaged_volume };
            });
    }

    function fetchGroupName(groupId) {
        return fetch(
            ESI_BASE + "/universe/groups/" + groupId + "/?datasource=tranquility&language=ko"
        )
            .then(function (r) {
                if (!r.ok) throw new Error("ESI universe/groups " + r.status);
                return r.json();
            })
            .then(function (d) {
                return d.name;
            });
    }

    /**
     * ESI엔 typeId 배치 조회가 없다(위 설명) — 그렇다고 typeId 하나당 fetch()를
     * 전부 동시에 쏘면(예전 코드가 그랬다) 재고 typeId 종류가 몇백 개로 늘어난
     * 지금은 순간적으로 수백 개 요청이 한 번에 나간다. ESI 쪽 요청 제한(초당 처리량
     * 넘으면 420/429)에 걸리거나, 그 요청들이 자잘하게 실패하기 시작하면 "이름 미확인"
     * 품목이 무더기로 뜬다 — pricing.js 의 Fuzzwork 청크 분할과 같은 이유로, 여기도
     * 동시 실행 개수를 제한한다.
     *
     * @param {Array} items
     * @param {number} limit 동시 진행 개수
     * @param {Function} worker item -> Promise (실패해도 reject 하지 않아야 한다 —
     *        여기서는 항상 resolve 하는 걸 호출부가 보장한다)
     * @returns {Promise<void>}
     */
    function runLimited(items, limit, worker) {
        return new Promise(function (resolve) {
            if (!items.length) {
                resolve();
                return;
            }
            var next = 0;
            var remaining = items.length;

            function pump() {
                while (next < items.length && limit > 0) {
                    var item = items[next++];
                    limit--; // 이 슬롯을 점유했다가, 끝나면 아래서 돌려준다
                    worker(item).then(function () {
                        limit++;
                        remaining--;
                        if (remaining === 0) resolve();
                        else pump();
                    });
                }
            }
            pump();
        });
    }

    /** ESI가 일시적으로 흔들릴 때(420/429/5xx) 한 번은 잠깐 쉬었다 다시 시도한다. */
    function withRetry(fn) {
        return fn().catch(function (err) {
            return new Promise(function (resolve) {
                setTimeout(resolve, 400 + Math.random() * 400);
            }).then(fn);
        });
    }

    var TYPE_CONCURRENCY = 12;

    /**
     * @param {number[]} typeIds
     * @returns {Promise<Object<number, {name:string, group:string, unitVolume:number}>>}
     *          실패한 typeId는 결과 맵에서 빠진다(가짜 이름을 채우지 않는다 —
     *          pricing.js와 같은 원칙).
     */
    function resolveTypes(typeIds) {
        var uniqueIds = [];
        var seen = Object.create(null);
        typeIds.forEach(function (id) {
            if (!seen[id]) {
                seen[id] = true;
                uniqueIds.push(id);
            }
        });

        var typeResult = {}; // typeId -> {name, groupId, unitVolume}
        var toFetchTypes = [];
        uniqueIds.forEach(function (id) {
            var cached = readCache(CACHE_PREFIX + id);
            if (cached) typeResult[id] = cached;
            else toFetchTypes.push(id);
        });

        var typesDone = runLimited(toFetchTypes, TYPE_CONCURRENCY, function (id) {
            return withRetry(function () {
                return fetchType(id);
            }).then(
                function (info) {
                    writeCache(CACHE_PREFIX + id, info);
                    typeResult[id] = info;
                },
                function () {
                    // 이 typeId는 결과에서 빠진다 — 화면은 "이름 미확인"으로 표시(app.js 몫).
                }
            );
        });

        return typesDone.then(function () {
            var groupIds = [];
            var groupSeen = Object.create(null);
            Object.keys(typeResult).forEach(function (id) {
                var gid = typeResult[id].groupId;
                if (gid != null && !groupSeen[gid]) {
                    groupSeen[gid] = true;
                    groupIds.push(gid);
                }
            });

            var groupNames = {};
            var toFetchGroups = [];
            groupIds.forEach(function (gid) {
                var cached = readCache(GROUP_CACHE_PREFIX + gid);
                if (cached) groupNames[gid] = cached;
                else toFetchGroups.push(gid);
            });

            var groupsDone = runLimited(toFetchGroups, TYPE_CONCURRENCY, function (gid) {
                return withRetry(function () {
                    return fetchGroupName(gid);
                }).then(
                    function (name) {
                        writeCache(GROUP_CACHE_PREFIX + gid, name);
                        groupNames[gid] = name;
                    },
                    function () {
                        // 그룹명 실패해도 typeId 이름/부피는 살아있으니 groupNames만 빈다.
                    }
                );
            });

            return groupsDone.then(function () {
                var out = {};
                Object.keys(typeResult).forEach(function (id) {
                    var t = typeResult[id];
                    out[id] = {
                        name: t.name,
                        group: groupNames[t.groupId] || "",
                        unitVolume: t.unitVolume,
                    };
                });
                return out;
            });
        });
    }

    window.BonsaiEveTypes = { resolveTypes: resolveTypes };
})();
