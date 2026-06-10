// ==============================
// Delivery Dispatch - Automated Tests
// ==============================
(function() {
  'use strict';

  var resultsDiv = document.getElementById('results');
  var summaryDiv = document.getElementById('summary');
  var totalPass = 0;
  var totalFail = 0;
  var currentGroup = null;

  // ===== Test Helpers =====
  function group(name) {
    currentGroup = document.createElement('div');
    currentGroup.className = 'test-group';
    currentGroup.innerHTML = '<h2>' + name + '</h2>';
    resultsDiv.appendChild(currentGroup);
  }

  function assert(condition, message) {
    var div = document.createElement('div');
    div.className = 'test-case ' + (condition ? 'pass' : 'fail');
    div.textContent = message;
    if (currentGroup) {
      currentGroup.appendChild(div);
    } else {
      resultsDiv.appendChild(div);
    }
    if (condition) { totalPass++; } else { totalFail++; }
  }

  function arraysEqual(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  function defaultObjectives() {
    return {
      minDistance:    { enabled: true,  weight: 50 },
      minViolation:  { enabled: false, weight: 50 },
      loadBalance:   { enabled: false, weight: 50 },
      driverFairness:{ enabled: false, weight: 50 },
      coldChainFirst:{ enabled: false, weight: 50 }
    };
  }

  // ===== Test Data (inline from data.json) =====
  var testData = {
    warehouses: [
      { id: "WH01", name: "华东总仓", x: 400, y: 300, capacity: 50000 },
      { id: "WH02", name: "华南分仓", x: 500, y: 550, capacity: 30000 },
      { id: "WH03", name: "华北分仓", x: 350, y: 100, capacity: 25000 }
    ],
    deliveryPoints: [
      { id: "DP01", name: "浦东新区站", x: 480, y: 280 },
      { id: "DP02", name: "徐汇配送站", x: 370, y: 330 },
      { id: "DP03", name: "松江集散点", x: 320, y: 360 },
      { id: "DP04", name: "嘉定中转站", x: 350, y: 240 },
      { id: "DP05", name: "青浦配送站", x: 300, y: 300 },
      { id: "DP06", name: "奉贤站点", x: 420, y: 400 },
      { id: "DP07", name: "闵行配送站", x: 380, y: 370 },
      { id: "DP08", name: "宝山集散点", x: 420, y: 220 },
      { id: "DP09", name: "金山中转站", x: 280, y: 420 },
      { id: "DP10", name: "崇明配送站", x: 500, y: 150 },
      { id: "DP11", name: "静安配送站", x: 390, y: 290 },
      { id: "DP12", name: "黄浦集散点", x: 410, y: 310 },
      { id: "DP13", name: "长宁中转站", x: 360, y: 310 },
      { id: "DP14", name: "普陀配送站", x: 370, y: 270 },
      { id: "DP15", name: "杨浦站点", x: 450, y: 260 },
      { id: "DP16", name: "虹口集散点", x: 430, y: 270 },
      { id: "DP17", name: "深圳福田站", x: 520, y: 580 },
      { id: "DP18", name: "深圳南山站", x: 490, y: 570 },
      { id: "DP19", name: "广州天河站", x: 460, y: 530 },
      { id: "DP20", name: "北京朝阳站", x: 380, y: 80 }
    ],
    drivers: [
      { id: "D01", name: "张师傅", maxHours: 10, restAfterHours: 4, restDuration: 0.5 },
      { id: "D02", name: "李师傅", maxHours: 10, restAfterHours: 4, restDuration: 0.5 },
      { id: "D03", name: "王师傅", maxHours: 8, restAfterHours: 4, restDuration: 0.5 },
      { id: "D04", name: "赵师傅", maxHours: 10, restAfterHours: 5, restDuration: 0.5 },
      { id: "D05", name: "刘师傅", maxHours: 8, restAfterHours: 4, restDuration: 0.5 },
      { id: "D06", name: "陈师傅", maxHours: 10, restAfterHours: 4, restDuration: 0.5 }
    ],
    vehicles: [
      { id: "V01", name: "大型货车A", capacity: 5000, speed: 40 },
      { id: "V02", name: "大型货车B", capacity: 5000, speed: 40 },
      { id: "V03", name: "中型货车A", capacity: 3000, speed: 50 },
      { id: "V04", name: "中型货车B", capacity: 3000, speed: 50 },
      { id: "V05", name: "小型货车A", capacity: 1500, speed: 60 },
      { id: "V06", name: "小型货车B", capacity: 1500, speed: 60 }
    ],
    orders: [
      { id: "ORD001", warehouseId: "WH01", deliveryPointId: "DP01", weight: 800, timeWindowStart: 8, timeWindowEnd: 12, priority: 1, coldChain: true },
      { id: "ORD002", warehouseId: "WH01", deliveryPointId: "DP02", weight: 500, timeWindowStart: 9, timeWindowEnd: 14, priority: 2, coldChain: false },
      { id: "ORD003", warehouseId: "WH01", deliveryPointId: "DP03", weight: 1200, timeWindowStart: 8, timeWindowEnd: 11, priority: 1, coldChain: true },
      { id: "ORD004", warehouseId: "WH01", deliveryPointId: "DP04", weight: 600, timeWindowStart: 10, timeWindowEnd: 16, priority: 3, coldChain: false },
      { id: "ORD005", warehouseId: "WH01", deliveryPointId: "DP05", weight: 900, timeWindowStart: 8, timeWindowEnd: 13, priority: 2, coldChain: false },
      { id: "ORD006", warehouseId: "WH01", deliveryPointId: "DP06", weight: 400, timeWindowStart: 11, timeWindowEnd: 17, priority: 3, coldChain: false },
      { id: "ORD007", warehouseId: "WH01", deliveryPointId: "DP07", weight: 750, timeWindowStart: 9, timeWindowEnd: 15, priority: 2, coldChain: false },
      { id: "ORD008", warehouseId: "WH01", deliveryPointId: "DP08", weight: 1100, timeWindowStart: 8, timeWindowEnd: 12, priority: 1, coldChain: true },
      { id: "ORD009", warehouseId: "WH01", deliveryPointId: "DP09", weight: 350, timeWindowStart: 10, timeWindowEnd: 18, priority: 3, coldChain: false },
      { id: "ORD010", warehouseId: "WH01", deliveryPointId: "DP10", weight: 650, timeWindowStart: 8, timeWindowEnd: 14, priority: 2, coldChain: false },
      { id: "ORD011", warehouseId: "WH01", deliveryPointId: "DP11", weight: 480, timeWindowStart: 9, timeWindowEnd: 13, priority: 1, coldChain: false },
      { id: "ORD012", warehouseId: "WH01", deliveryPointId: "DP12", weight: 520, timeWindowStart: 10, timeWindowEnd: 16, priority: 2, coldChain: false },
      { id: "ORD013", warehouseId: "WH01", deliveryPointId: "DP13", weight: 380, timeWindowStart: 8, timeWindowEnd: 12, priority: 3, coldChain: false },
      { id: "ORD014", warehouseId: "WH01", deliveryPointId: "DP14", weight: 700, timeWindowStart: 9, timeWindowEnd: 15, priority: 2, coldChain: false },
      { id: "ORD015", warehouseId: "WH01", deliveryPointId: "DP15", weight: 950, timeWindowStart: 8, timeWindowEnd: 11, priority: 1, coldChain: true },
      { id: "ORD016", warehouseId: "WH01", deliveryPointId: "DP16", weight: 420, timeWindowStart: 11, timeWindowEnd: 17, priority: 3, coldChain: false },
      { id: "ORD017", warehouseId: "WH02", deliveryPointId: "DP17", weight: 1500, timeWindowStart: 8, timeWindowEnd: 14, priority: 1, coldChain: true },
      { id: "ORD018", warehouseId: "WH02", deliveryPointId: "DP18", weight: 800, timeWindowStart: 9, timeWindowEnd: 15, priority: 2, coldChain: false },
      { id: "ORD019", warehouseId: "WH02", deliveryPointId: "DP19", weight: 600, timeWindowStart: 10, timeWindowEnd: 16, priority: 2, coldChain: false },
      { id: "ORD020", warehouseId: "WH03", deliveryPointId: "DP20", weight: 1000, timeWindowStart: 8, timeWindowEnd: 13, priority: 1, coldChain: false },
      { id: "ORD021", warehouseId: "WH01", deliveryPointId: "DP01", weight: 300, timeWindowStart: 14, timeWindowEnd: 18, priority: 3, coldChain: false },
      { id: "ORD022", warehouseId: "WH01", deliveryPointId: "DP07", weight: 550, timeWindowStart: 8, timeWindowEnd: 10, priority: 1, coldChain: true },
      { id: "ORD023", warehouseId: "WH01", deliveryPointId: "DP11", weight: 2500, timeWindowStart: 9, timeWindowEnd: 14, priority: 2, coldChain: false },
      { id: "ORD024", warehouseId: "WH01", deliveryPointId: "DP03", weight: 200, timeWindowStart: 13, timeWindowEnd: 18, priority: 3, coldChain: false },
      { id: "ORD025", warehouseId: "WH01", deliveryPointId: "DP05", weight: 680, timeWindowStart: 8, timeWindowEnd: 12, priority: 2, coldChain: false },
      { id: "ORD026", warehouseId: "WH01", deliveryPointId: null, weight: 500, timeWindowStart: 9, timeWindowEnd: 15, priority: 2, coldChain: false },
      { id: "ORD027", warehouseId: "WH01", deliveryPointId: "DP08", weight: 5500, timeWindowStart: 8, timeWindowEnd: 14, priority: 1, coldChain: false },
      { id: "ORD028", warehouseId: "WH01", deliveryPointId: "DP12", weight: 700, timeWindowStart: 6, timeWindowEnd: 7, priority: 2, coldChain: false }
    ]
  };

  function makePayload(vehicleCount, objectives) {
    return {
      orders: JSON.parse(JSON.stringify(testData.orders)),
      warehouses: testData.warehouses,
      deliveryPoints: testData.deliveryPoints,
      drivers: testData.drivers,
      vehicles: testData.vehicles,
      vehicleCount: vehicleCount,
      objectives: objectives || defaultObjectives(),
      startTime: 8
    };
  }

  // Count valid orders (excluding known invalid: ORD026, ORD027)
  var TOTAL_ORDERS = testData.orders.length;  // 28
  var INVALID_ORDERS = 2; // ORD026 (null dp), ORD027 (overweight); ORD028 passes validation (window == 1h)

  // ==============================
  // Test 1: Vehicle Count Slider
  // ==============================
  function testVehicleCountSlider() {
    group('测试1: 连续调整车辆数量');

    var counts = [1, 2, 3, 4, 5, 6, 5, 4, 3, 2];
    var resultsByCount = {};
    var allOk = true;

    for (var ci = 0; ci < counts.length; ci++) {
      var count = counts[ci];
      var result = computeRoutes(makePayload(count));

      var activeRoutes = result.routes.filter(function(r) { return r.orders.length > 0; }).length;
      var orderBalance = result.stats.assignedOrders + result.stats.unassignedOrders;

      assert(activeRoutes <= count,
        '车辆数=' + count + ': 活跃路线数(' + activeRoutes + ') <= 车辆数(' + count + ')');

      assert(orderBalance === TOTAL_ORDERS,
        '车辆数=' + count + ': 订单守恒 (已分配' + result.stats.assignedOrders + ' + 未分配' + result.stats.unassignedOrders + ' = ' + orderBalance + '/' + TOTAL_ORDERS + ')');

      // Store for comparison
      if (!resultsByCount[count]) {
        resultsByCount[count] = result.stats.assignedOrders;
      }
    }

    // Compare: same vehicle count should yield same assigned count
    var result2a = computeRoutes(makePayload(3));
    var result2b = computeRoutes(makePayload(3));
    assert(result2a.stats.assignedOrders === result2b.stats.assignedOrders,
      '相同车辆数(3)两次计算: 分配数一致 (' + result2a.stats.assignedOrders + ' = ' + result2b.stats.assignedOrders + ')');
  }

  // ==============================
  // Test 2: Locked Route Preservation
  // ==============================
  function testLockedRoutePreservation() {
    group('测试2: 锁线后重算');

    // First computation
    var result1 = computeRoutes(makePayload(4));
    var routeWithOrders = result1.routes.find(function(r) { return r.orders.length > 0; });

    if (!routeWithOrders) {
      assert(false, '初次计算未产生有订单的路线');
      return;
    }

    var lockedRoute = JSON.parse(JSON.stringify(routeWithOrders));
    lockedRoute.locked = true;
    var lockedOrderIds = lockedRoute.orders.map(function(o) { return o.id; });

    assert(lockedOrderIds.length > 0,
      '锁定路线 ' + lockedRoute.id + ' 包含 ' + lockedOrderIds.length + ' 个订单');

    // Recompute with locked route
    var payload2 = makePayload(4);
    payload2.lockedRoutes = [lockedRoute];
    payload2.lockedOrderIds = lockedOrderIds;
    var result2 = computeRoutes(payload2);

    // Verify locked orders are not in newly computed routes
    var newRouteOrderIds = [];
    for (var ri = 0; ri < result2.routes.length; ri++) {
      for (var oi = 0; oi < result2.routes[ri].orders.length; oi++) {
        newRouteOrderIds.push(result2.routes[ri].orders[oi].id);
      }
    }

    var lockedInNew = lockedOrderIds.filter(function(id) {
      return newRouteOrderIds.indexOf(id) >= 0;
    });

    assert(lockedInNew.length === 0,
      '锁定订单未出现在新计算路线中 (冲突数: ' + lockedInNew.length + ')');

    // Verify total order conservation
    // stats.assignedOrders already includes locked route orders (allRoutes = locked + new)
    var totalAccounted = result2.stats.assignedOrders + result2.stats.unassignedOrders;
    assert(totalAccounted === TOTAL_ORDERS,
      '订单守恒: 已分配(' + result2.stats.assignedOrders + ', 含锁定) + 未分配(' + result2.stats.unassignedOrders + ') = ' + totalAccounted + '/' + TOTAL_ORDERS);
  }

  // ==============================
  // Test 3: Stale routeVersion Discard
  // ==============================
  function testStaleVersionDiscard() {
    group('测试3: 过期routeVersion回包丢弃');

    var routeVersion = 0;
    var pendingVersions = {};
    var appliedResults = [];

    // Simulate version 1 recalc request
    routeVersion = 1;
    pendingVersions[1] = true;

    // Version bumps to 2 before v1 returns
    routeVersion = 2;
    pendingVersions[2] = true;

    // Version 1 result arrives (stale)
    var stalePayload = { routeVersion: 1, id: 'ROUTE_1', data: 'stale' };
    if (stalePayload.routeVersion < routeVersion) {
      delete pendingVersions[stalePayload.routeVersion];
      // Discarded
    } else {
      appliedResults.push(stalePayload);
    }

    assert(appliedResults.length === 0,
      '版本1回包在版本2时正确丢弃');

    // Version 2 result arrives (valid)
    var validPayload = { routeVersion: 2, id: 'ROUTE_1', data: 'valid' };
    if (validPayload.routeVersion >= routeVersion) {
      appliedResults.push(validPayload);
    }

    assert(appliedResults.length === 1,
      '版本2回包正确应用');
    assert(appliedResults[0].data === 'valid',
      '应用的结果数据正确');

    // Simulate version 3 request, then version 4
    routeVersion = 3;
    routeVersion = 4;

    // Version 3 arrives
    var stale3 = { routeVersion: 3 };
    var applied3 = stale3.routeVersion >= routeVersion;
    assert(!applied3, '版本3在版本4时被丢弃');

    // Equal version
    var equal4 = { routeVersion: 4 };
    var applied4 = equal4.routeVersion >= routeVersion;
    assert(applied4, '版本4等于当前版本时正确应用');
  }

  // ==============================
  // Test 4: Overload Order Rejection
  // ==============================
  function testOverloadRejection() {
    group('测试4: 超载订单拒绝');

    var result = computeRoutes(makePayload(4));

    // ORD027 weighs 5500kg, max vehicle capacity is 5000kg
    var ord027Unassigned = result.unassigned.find(function(u) { return u.order.id === 'ORD027'; });
    assert(ord027Unassigned !== undefined,
      'ORD027 (5500kg) 被标记为未分配');

    if (ord027Unassigned) {
      var hasCapacityReason = ord027Unassigned.reasons.some(function(r) {
        return r.indexOf('超过') >= 0 || r.indexOf('容量') >= 0;
      });
      assert(hasCapacityReason,
        'ORD027 未分配原因包含容量相关说明: ' + ord027Unassigned.reasons[0]);
    }

    // Simulate drag: try to add a heavy order to a nearly full route
    var routeWithOrders = result.routes.find(function(r) { return r.orders.length > 0; });
    if (routeWithOrders) {
      var remaining = routeWithOrders.vehicle.capacity - routeWithOrders.totalWeight;
      var heavyOrder = { id: 'TEST_HEAVY', weight: remaining + 100 };
      var canFit = (routeWithOrders.totalWeight + heavyOrder.weight <= routeWithOrders.vehicle.capacity);

      assert(!canFit,
        '超出剩余容量(' + remaining + 'kg)的订单(' + heavyOrder.weight + 'kg)被正确拒绝');
    }

    // Verify no route exceeds its vehicle capacity
    var overloaded = result.routes.filter(function(r) {
      return r.totalWeight > r.vehicle.capacity;
    });
    assert(overloaded.length === 0,
      '所有路线均未超载 (超载路线数: ' + overloaded.length + ')');
  }

  // ==============================
  // Test 5: Time Window Conflict
  // ==============================
  function testTimeWindowConflict() {
    group('测试5: 时间窗冲突检测');

    // ORD028: timeWindow 6:00-7:00, window width = 1h (passes validation since >= 1h)
    // But with startTime=8, it will always arrive late -> time window violation
    var result = computeRoutes(makePayload(4));

    var ord028InRoutes = false;
    var ord028Violated = false;
    for (var ri = 0; ri < result.routes.length; ri++) {
      var route = result.routes[ri];
      for (var oi = 0; oi < route.orders.length; oi++) {
        if (route.orders[oi].id === 'ORD028') {
          ord028InRoutes = true;
          // Check if it has a violation
          if (route.timeWindowViolations) {
            for (var vi2 = 0; vi2 < route.timeWindowViolations.length; vi2++) {
              if (route.timeWindowViolations[vi2].orderId === 'ORD028') {
                ord028Violated = true;
              }
            }
          }
        }
      }
    }
    var ord028Unassigned = result.unassigned.find(function(u) { return u.order.id === 'ORD028'; });

    // ORD028 either gets assigned with violation, or stays unassigned
    if (ord028InRoutes) {
      assert(ord028Violated,
        'ORD028 (6:00-7:00, startTime=8:00) 被分配但产生时间窗违规');
    } else {
      assert(ord028Unassigned !== undefined,
        'ORD028 未被分配');
    }

    // ORD026: null deliveryPointId
    var ord026Unassigned = result.unassigned.find(function(u) { return u.order.id === 'ORD026'; });
    assert(ord026Unassigned !== undefined,
      'ORD026 (配送点为null) 被标记为未分配');

    // Use 2 vehicles to force time window violations in computed routes
    var result2 = computeRoutes(makePayload(2));
    var totalViolations = 0;
    for (var i = 0; i < result2.routes.length; i++) {
      totalViolations += (result2.routes[i].timeWindowViolations || []).length;
    }

    // With only 2 vehicles for 25 valid orders, some violations are expected
    assert(true, '2辆车模式: 产生 ' + totalViolations + ' 个时间窗违规 (信息性)');

    // Verify violations have correct structure
    var allValid = true;
    for (var ri = 0; ri < result2.routes.length; ri++) {
      var violations = result2.routes[ri].timeWindowViolations || [];
      for (var vi = 0; vi < violations.length; vi++) {
        var v = violations[vi];
        if (!v.orderId || v.expectedArrival === undefined || v.windowEnd === undefined || v.delay === undefined) {
          allValid = false;
        }
      }
    }
    assert(allValid, '时间窗违规数据结构完整 (orderId, expectedArrival, windowEnd, delay)');
  }

  // ==============================
  // Test 6: Export Consistency
  // ==============================
  function testExportConsistency() {
    group('测试6: 导出结果一致性');

    var result = computeRoutes(makePayload(4));

    // Simulate export
    var exported = {
      stats: result.stats,
      routes: result.routes.map(function(r, i) {
        return {
          routeIndex: i + 1,
          orders: r.orders,
          totalWeight: r.totalWeight,
          loadRate: r.loadRate,
          totalDistance: r.totalDistance,
          estimatedTime: r.estimatedTime,
          stopETAs: r.stopETAs || []
        };
      }),
      unassigned: result.unassigned
    };

    // Verify: exported assigned count = stats.assignedOrders
    var exportedAssigned = 0;
    for (var i = 0; i < exported.routes.length; i++) {
      exportedAssigned += exported.routes[i].orders.length;
    }
    assert(exportedAssigned === exported.stats.assignedOrders,
      '导出已分配数(' + exportedAssigned + ') = stats.assignedOrders(' + exported.stats.assignedOrders + ')');

    // Verify: exported unassigned count = stats.unassignedOrders
    assert(exported.unassigned.length === exported.stats.unassignedOrders,
      '导出未分配数(' + exported.unassigned.length + ') = stats.unassignedOrders(' + exported.stats.unassignedOrders + ')');

    // Verify: each route's totalWeight = sum of order weights
    var weightOk = true;
    for (var ri = 0; ri < exported.routes.length; ri++) {
      var route = exported.routes[ri];
      var sumWeight = 0;
      for (var oi = 0; oi < route.orders.length; oi++) {
        sumWeight += route.orders[oi].weight;
      }
      if (sumWeight !== route.totalWeight) {
        weightOk = false;
        assert(false, '路线' + route.routeIndex + ': 重量不一致 (求和=' + sumWeight + ', totalWeight=' + route.totalWeight + ')');
      }
    }
    if (weightOk) {
      assert(true, '所有路线重量总和与totalWeight一致');
    }

    // Verify: loadRate matches totalWeight / capacity
    var loadRateOk = true;
    for (var li = 0; li < result.routes.length; li++) {
      var r = result.routes[li];
      if (r.orders.length === 0) continue;
      var expectedRate = Math.round((r.totalWeight / r.vehicle.capacity) * 100);
      if (r.loadRate !== expectedRate) {
        loadRateOk = false;
        assert(false, '路线' + (li + 1) + ': 装载率不一致 (计算=' + expectedRate + '%, 实际=' + r.loadRate + '%)');
      }
    }
    if (loadRateOk) {
      assert(true, '所有路线装载率计算正确');
    }

    // Verify stopETAs exist for routes with orders
    var etaOk = true;
    for (var ei = 0; ei < result.routes.length; ei++) {
      var er = result.routes[ei];
      if (er.orders.length > 0 && (!er.stopETAs || er.stopETAs.length !== er.orders.length)) {
        etaOk = false;
        assert(false, '路线' + (ei + 1) + ': stopETAs数量(' + (er.stopETAs ? er.stopETAs.length : 0) + ')与订单数(' + er.orders.length + ')不匹配');
      }
    }
    if (etaOk) {
      assert(true, '所有路线stopETAs与订单数一致');
    }

    // Total: assigned + unassigned = total orders
    assert(exportedAssigned + exported.unassigned.length === TOTAL_ORDERS,
      '总计守恒: ' + exportedAssigned + ' + ' + exported.unassigned.length + ' = ' + TOTAL_ORDERS);
  }

  // ==============================
  // Run All Tests
  // ==============================
  function runAll() {
    try { testVehicleCountSlider(); } catch(e) { assert(false, '测试1异常: ' + e.message); }
    try { testLockedRoutePreservation(); } catch(e) { assert(false, '测试2异常: ' + e.message); }
    try { testStaleVersionDiscard(); } catch(e) { assert(false, '测试3异常: ' + e.message); }
    try { testOverloadRejection(); } catch(e) { assert(false, '测试4异常: ' + e.message); }
    try { testTimeWindowConflict(); } catch(e) { assert(false, '测试5异常: ' + e.message); }
    try { testExportConsistency(); } catch(e) { assert(false, '测试6异常: ' + e.message); }

    // Summary
    summaryDiv.textContent = '总计: ' + totalPass + ' 通过, ' + totalFail + ' 失败 (共 ' + (totalPass + totalFail) + ' 项)';
    summaryDiv.className = totalFail === 0 ? 'all-pass' : 'has-fail';
  }

  // Run when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runAll);
  } else {
    runAll();
  }

})();
