/**
 * 목업 재고 데이터 — API 연결 전까지 화면을 채우기 위한 임시 값이다.
 *
 * 주의: typeId / unitVolume 은 전부 자리표시자다. 실제 값은 ESI(assets, universe/types)에서
 * 받아와야 하며, 아이콘 파일명도 이 typeId를 따라가므로 교체 전까지는 아이콘이 뜨지 않는다.
 * name 은 EVE 인게임 표기와 정확히 일치해야 한다 — 멀티바이가 이름으로 품목을 찾는다.
 *
 * stocked: ESI corp assets 집계 결과
 * target:  테넌트가 설정한 목표 재고
 * history: 재고 수량 로그 (오래된 것 → 최신). 10분 간격 크론이 남기는 값을 가정한다.
 */
(function () {
    "use strict";

    var SAMPLE_MINUTES = 10;
    var HISTORY_HOURS = 24;
    var POINTS = (HISTORY_HOURS * 60) / SAMPLE_MINUTES; // 144

    /* 고정 시드 PRNG — 새로고침해도 그래프가 요동치지 않게 한다. */
    function mulberry32(seed) {
        return function () {
            seed |= 0;
            seed = (seed + 0x6d2b79f5) | 0;
            var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    /**
     * 24시간치 소비 곡선을 만든다. 대체로 우하향하되, 가끔 보급이 들어와 계단식으로 튄다.
     * 마지막 값은 반드시 현재 보유량과 같다.
     */
    function makeHistory(seed, endValue, target) {
        var rand = mulberry32(seed);
        var restockTo = Math.max(endValue, Math.round(target * (0.7 + rand() * 0.5)));
        var series = new Array(POINTS);
        var value = restockTo;

        for (var i = 0; i < POINTS; i++) {
            var drain = rand() < 0.62 ? Math.round(rand() * (restockTo / POINTS) * 2.6) : 0;
            value = Math.max(0, value - drain);
            // 드물게 보급이 들어온다
            if (rand() < 0.02) value = Math.min(restockTo, value + Math.round(restockTo * 0.3));
            series[i] = value;
        }
        series[POINTS - 1] = endValue;
        return series;
    }

    // typeId / name / unitVolume 전부 ESI /universe/types/{id} 로 확인한 실제 값이다.
    //
    // unitVolume 은 `volume` 이 아니라 **`packaged_volume`** 을 쓴다. 모듈·탄약은 둘이 같지만
    // 선박은 10배 가까이 벌어진다 (Muninn 96,000 vs 10,000 / Guardian 115,000 vs 10,000).
    // 행어에 쌓아 두는 것도, 사서 실어 나르는 것도 포장 상태이므로 여기서 필요한 값은 후자다.
    var items = [
        { typeId: 2456, name: "Hobgoblin II", group: "Light Scout Drone", stocked: 60, target: 300, unitVolume: 5 },
        { typeId: 2488, name: "Warrior II", group: "Light Scout Drone", stocked: 25, target: 150, unitVolume: 5 },
        { typeId: 2185, name: "Hammerhead II", group: "Medium Scout Drone", stocked: 90, target: 120, unitVolume: 10 },
        { typeId: 28668, name: "Nanite Repair Paste", group: "Nanite Paste", stocked: 140, target: 400, unitVolume: 0.01 },
        { typeId: 2048, name: "Damage Control II", group: "Damage Control", stocked: 12, target: 40, unitVolume: 5 },
        { typeId: 3841, name: "Large Shield Extender II", group: "Shield Extender", stocked: 34, target: 30, unitVolume: 20 },
        { typeId: 2281, name: "Multispectrum Shield Hardener II", group: "Shield Hardener", stocked: 8, target: 30, unitVolume: 5 },
        { typeId: 12058, name: "10MN Afterburner II", group: "Propulsion Module", stocked: 22, target: 25, unitVolume: 5 },
        { typeId: 3244, name: "Warp Disruptor II", group: "Warp Scrambler", stocked: 41, target: 40, unitVolume: 5 },
        { typeId: 23025, name: "Caldari Navy Antimatter Charge M", group: "Hybrid Charge", stocked: 4800, target: 20000, unitVolume: 0.0125 },
        // "Scourge Fury Heavy Assault Missile" 은 게임에 없는 이름이었다.
        // Fury 는 Heavy Missile 계열이고, HAM 의 T2 는 Rage / Javelin 이다.
        { typeId: 2679, name: "Scourge Rage Heavy Assault Missile", group: "Advanced Missile", stocked: 9200, target: 15000, unitVolume: 0.015 },
        { typeId: 21896, name: "Republic Fleet EMP M", group: "Projectile Ammo", stocked: 16000, target: 12000, unitVolume: 0.0125 },
        { typeId: 12015, name: "Muninn", group: "Heavy Assault Cruiser", stocked: 3, target: 12, unitVolume: 10000 },
        { typeId: 11987, name: "Guardian", group: "Logistics Cruiser", stocked: 5, target: 8, unitVolume: 10000 },
        { typeId: 11978, name: "Scimitar", group: "Logistics Cruiser", stocked: 9, target: 8, unitVolume: 10000 },
    ];

    items.forEach(function (item, i) {
        item.history = makeHistory(i * 7919 + 13, item.stocked, item.target);
    });

    // 마지막 표본 시각. 10분 경계로 내려 맞춰 크론이 찍은 것처럼 보이게 한다.
    var now = new Date();
    now.setMinutes(Math.floor(now.getMinutes() / SAMPLE_MINUTES) * SAMPLE_MINUTES, 0, 0);

    window.BONSAI_MOCK = {
        hangar: "Jita IV-4 — Corp Hangar 1",
        syncedAt: "4분 전 동기화",
        sampledAt: now.toISOString(),
        sampleMinutes: SAMPLE_MINUTES,
        historyHours: HISTORY_HOURS,
        items: items,
    };
})();
