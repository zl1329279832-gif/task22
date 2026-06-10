// ==============================
// Delivery Dispatch Demo System
// Main Application Logic
// ==============================

(function() {
  'use strict';

  // ===== State =====
  const state = {
    data: null,          // loaded JSON data
    routes: [],          // computed routes
    unassigned: [],      // unassigned orders
    stats: null,         // computation stats
    worker: null,        // Web Worker reference
    selectedRoute: null, // highlighted route index

    // Canvas state
    canvas: null,
    ctx: null,
    zoom: 1,
    panX: 0,
    panY: 0,
    isPanning: false,
    panMoved: false,
    panStartX: 0,
    panStartY: 0,
    panStartClientX: 0,
    panStartClientY: 0,

    // Drag & drop
    dragOrder: null,
    dragSourceRoute: null,

    // Route colors
    routeColors: ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4'],

    // Version tracking for async isolation
    routeVersion: 0,
    computeRequestId: 0,
    pendingRecalcVersions: new Set(),

    // Multi-objective optimization
    objectives: {
      minDistance:    { enabled: true,  weight: 50 },
      minViolation:  { enabled: false, weight: 50 },
      loadBalance:   { enabled: false, weight: 50 },
      driverFairness:{ enabled: false, weight: 50 },
      coldChainFirst:{ enabled: false, weight: 50 }
    },

    // Route locking
    lockedRouteIds: new Set()
  };

  // ===== DOM References =====
  const dom = {};

  function cacheDom() {
    dom.btnImport = document.getElementById('btnImport');
    dom.btnExport = document.getElementById('btnExport');
    dom.btnSave = document.getElementById('btnSave');
    dom.btnLoad = document.getElementById('btnLoad');
    dom.btnCompute = document.getElementById('btnCompute');
    dom.btnZoomIn = document.getElementById('btnZoomIn');
    dom.btnZoomOut = document.getElementById('btnZoomOut');
    dom.btnReset = document.getElementById('btnReset');
    dom.fileInput = document.getElementById('fileInput');
    dom.vehicleCount = document.getElementById('vehicleCount');
    dom.vehicleCountLabel = document.getElementById('vehicleCountLabel');
    dom.strategy = document.getElementById('strategy');
    dom.startTime = document.getElementById('startTime');
    dom.canvasInfo = document.getElementById('canvasInfo');
    dom.statsBar = document.getElementById('statsBar');
    dom.routeList = document.getElementById('routeList');
    dom.unassignedSection = document.getElementById('unassignedSection');
    dom.unassignedList = document.getElementById('unassignedList');
    dom.importModal = document.getElementById('importModal');
    dom.modalClose = document.getElementById('modalClose');
    dom.btnSelectFile = document.getElementById('btnSelectFile');
    dom.importTextarea = document.getElementById('importTextarea');
    dom.btnImportCancel = document.getElementById('btnImportCancel');
    dom.btnImportConfirm = document.getElementById('btnImportConfirm');
    dom.toastContainer = document.getElementById('toastContainer');

    // Overview
    dom.ovWarehouses = document.getElementById('ovWarehouses');
    dom.ovPoints = document.getElementById('ovPoints');
    dom.ovOrders = document.getElementById('ovOrders');
    dom.ovDrivers = document.getElementById('ovDrivers');
    dom.ovVehicles = document.getElementById('ovVehicles');
    dom.ovInvalid = document.getElementById('ovInvalid');

    // Stats
    dom.statAssigned = document.getElementById('statAssigned');
    dom.statUnassigned = document.getElementById('statUnassigned');
    dom.statLoadRate = document.getElementById('statLoadRate');
    dom.statRisk = document.getElementById('statRisk');

    // Objective controls
    dom.objMinDist = document.getElementById('objMinDist');
    dom.objMinDistW = document.getElementById('objMinDistW');
    dom.objMinDistWL = document.getElementById('objMinDistWL');
    dom.objMinViol = document.getElementById('objMinViol');
    dom.objMinViolW = document.getElementById('objMinViolW');
    dom.objMinViolWL = document.getElementById('objMinViolWL');
    dom.objLoadBal = document.getElementById('objLoadBal');
    dom.objLoadBalW = document.getElementById('objLoadBalW');
    dom.objLoadBalWL = document.getElementById('objLoadBalWL');
    dom.objDriverFair = document.getElementById('objDriverFair');
    dom.objDriverFairW = document.getElementById('objDriverFairW');
    dom.objDriverFairWL = document.getElementById('objDriverFairWL');
    dom.objColdChain = document.getElementById('objColdChain');
    dom.objColdChainW = document.getElementById('objColdChainW');
    dom.objColdChainWL = document.getElementById('objColdChainWL');
  }

  // ===== Initialization =====
  function init() {
    cacheDom();
    initCanvas();
    initWorker();
    bindEvents();
    loadData();
  }

  function initCanvas() {
    state.canvas = document.getElementById('mapCanvas');
    state.ctx = state.canvas.getContext('2d');
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
  }

  function resizeCanvas() {
    const container = state.canvas.parentElement;
    state.canvas.width = container.clientWidth;
    state.canvas.height = container.clientHeight;
    renderCanvas();
  }

  function initWorker() {
    state.worker = new Worker('worker.js');
    state.worker.onmessage = function(e) {
      const { type, payload } = e.data;
      if (type === 'ROUTES_RESULT') {
        handleRoutesResult(payload);
      } else if (type === 'RECALC_RESULT') {
        handleRecalcResult(payload);
      }
    };
    state.worker.onerror = function(err) {
      console.error('Worker error:', err);
      showToast('Worker 计算出错: ' + err.message, 'error');
    };
  }

  // Build shared lookup maps from state.data
  function buildDpMap() {
    const dpMap = {};
    if (state.data) state.data.deliveryPoints.forEach(dp => { dpMap[dp.id] = dp; });
    return dpMap;
  }
  function buildWhMap() {
    const whMap = {};
    if (state.data) state.data.warehouses.forEach(wh => { whMap[wh.id] = wh; });
    return whMap;
  }

  // ===== Data Loading =====
  function loadData() {
    fetch('data.json')
      .then(r => r.json())
      .then(data => {
        state.data = data;
        updateOverview();
        autoFitCanvas();
        renderCanvas();
        showToast('数据加载完成', 'success');
        dom.canvasInfo.textContent = '就绪 - ' + data.orders.length + ' 个订单待调度';
      })
      .catch(err => {
        console.error('Failed to load data:', err);
        showToast('数据加载失败: ' + err.message, 'error');
      });
  }

  function updateOverview() {
    if (!state.data) return;
    dom.ovWarehouses.textContent = state.data.warehouses.length;
    dom.ovPoints.textContent = state.data.deliveryPoints.length;
    dom.ovOrders.textContent = state.data.orders.length;
    dom.ovDrivers.textContent = state.data.drivers.length;
    dom.ovVehicles.textContent = state.data.vehicles.length;

    // Count invalid orders
    let invalid = 0;
    const dpMap = {};
    state.data.deliveryPoints.forEach(dp => { dpMap[dp.id] = dp; });
    const maxCap = Math.max(...state.data.vehicles.map(v => v.capacity));

    for (const order of state.data.orders) {
      if (!order.deliveryPointId || !dpMap[order.deliveryPointId] ||
          order.weight > maxCap || order.timeWindowEnd <= order.timeWindowStart ||
          order.timeWindowEnd - order.timeWindowStart < 1) {
        invalid++;
      }
    }
    dom.ovInvalid.textContent = invalid;
  }

  // ===== Event Binding =====
  function bindEvents() {
    // Vehicle count slider
    dom.vehicleCount.addEventListener('input', function() {
      dom.vehicleCountLabel.textContent = this.value;
    });

    // Compute button
    dom.btnCompute.addEventListener('click', startComputation);

    // Import/Export
    dom.btnImport.addEventListener('click', () => { dom.importModal.style.display = 'flex'; });
    dom.modalClose.addEventListener('click', closeImportModal);
    dom.btnImportCancel.addEventListener('click', closeImportModal);
    dom.btnSelectFile.addEventListener('click', () => dom.fileInput.click());
    dom.fileInput.addEventListener('change', handleFileSelect);
    dom.btnImportConfirm.addEventListener('click', handleImportConfirm);

    dom.btnExport.addEventListener('click', exportPlan);
    dom.btnSave.addEventListener('click', savePlan);
    dom.btnLoad.addEventListener('click', loadPlan);

    // Zoom
    dom.btnZoomIn.addEventListener('click', () => { state.zoom *= 1.2; renderCanvas(); });
    dom.btnZoomOut.addEventListener('click', () => { state.zoom /= 1.2; renderCanvas(); });
    dom.btnReset.addEventListener('click', () => { autoFitCanvas(); renderCanvas(); });

    // Canvas mouse events
    state.canvas.addEventListener('mousedown', onCanvasMouseDown);
    state.canvas.addEventListener('mousemove', onCanvasMouseMove);

    // Objective weight sliders
    var sliderPairs = [
      ['objMinDistW', 'objMinDistWL'],
      ['objMinViolW', 'objMinViolWL'],
      ['objLoadBalW', 'objLoadBalWL'],
      ['objDriverFairW', 'objDriverFairWL'],
      ['objColdChainW', 'objColdChainWL']
    ];
    sliderPairs.forEach(function(pair) {
      var slider = dom[pair[0]];
      var label = dom[pair[1]];
      if (slider && label) {
        slider.addEventListener('input', function() {
          label.textContent = this.value;
        });
      }
    });
    state.canvas.addEventListener('mouseup', onCanvasMouseUp);
    state.canvas.addEventListener('mouseleave', function() {
      state.isPanning = false;
    });
    state.canvas.addEventListener('wheel', onCanvasWheel, { passive: false });
  }

  // ===== Canvas Interaction =====
  function autoFitCanvas() {
    if (!state.data) return;
    const allPoints = [
      ...state.data.warehouses,
      ...state.data.deliveryPoints
    ].filter(p => p.x != null && p.y != null);

    if (allPoints.length === 0) return;

    const xs = allPoints.map(p => p.x);
    const ys = allPoints.map(p => p.y);
    const minX = Math.min(...xs) - 40;
    const maxX = Math.max(...xs) + 40;
    const minY = Math.min(...ys) - 40;
    const maxY = Math.max(...ys) + 40;

    const dataW = maxX - minX;
    const dataH = maxY - minY;
    const cw = state.canvas.width;
    const ch = state.canvas.height;

    state.zoom = Math.min(cw / dataW, ch / dataH) * 0.9;
    state.panX = (cw - dataW * state.zoom) / 2 - minX * state.zoom;
    state.panY = (ch - dataH * state.zoom) / 2 - minY * state.zoom;
  }

  // Convert screen (client) coordinates to data-space coordinates
  function screenToData(clientX, clientY) {
    const rect = state.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - state.panX) / state.zoom,
      y: (clientY - rect.top - state.panY) / state.zoom
    };
  }

  // Convert data-space coordinates to screen (client) coordinates
  function dataToScreen(dataX, dataY) {
    const rect = state.canvas.getBoundingClientRect();
    return {
      x: dataX * state.zoom + state.panX + rect.left,
      y: dataY * state.zoom + state.panY + rect.top
    };
  }

  function onCanvasMouseDown(e) {
    state.isPanning = true;
    state.panMoved = false;
    state.panStartX = e.clientX - state.panX;
    state.panStartY = e.clientY - state.panY;
    state.panStartClientX = e.clientX;
    state.panStartClientY = e.clientY;
  }

  function onCanvasMouseMove(e) {
    if (state.isPanning) {
      const dx = e.clientX - state.panStartClientX;
      const dy = e.clientY - state.panStartClientY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        state.panMoved = true;
      }
      state.panX = e.clientX - state.panStartX;
      state.panY = e.clientY - state.panStartY;
      renderCanvas();
    }
  }

  function onCanvasMouseUp(e) {
    const wasPanning = state.isPanning;
    const moved = state.panMoved;
    state.isPanning = false;

    // If the user clicked without dragging, try to select a route by hitting a delivery point
    if (wasPanning && !moved && state.routes.length > 0 && state.data) {
      onCanvasClick(e);
    }
  }

  function onCanvasClick(e) {
    const dataPos = screenToData(e.clientX, e.clientY);
    const hitRadius = 15 / state.zoom; // 15px in screen space
    const dpMap = buildDpMap();

    // Find nearest delivery point within hit radius
    let bestDist = Infinity;
    let bestDp = null;

    for (const dp of state.data.deliveryPoints) {
      if (dp.x == null || dp.y == null) continue;
      const dx = dp.x - dataPos.x;
      const dy = dp.y - dataPos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < hitRadius && dist < bestDist) {
        bestDist = dist;
        bestDp = dp;
      }
    }

    if (bestDp) {
      // Find which route contains this delivery point
      let foundRouteIndex = -1;
      for (let i = 0; i < state.routes.length; i++) {
        for (const order of state.routes[i].orders) {
          if (order.deliveryPointId === bestDp.id) {
            foundRouteIndex = i;
            break;
          }
        }
        if (foundRouteIndex >= 0) break;
      }

      if (foundRouteIndex >= 0) {
        state.selectedRoute = (state.selectedRoute === foundRouteIndex) ? null : foundRouteIndex;
        renderCanvas();
        showToast('选中路线 ' + (foundRouteIndex + 1) + ': ' + bestDp.name, 'info');
      }
    } else {
      // Clicked empty space — deselect
      if (state.selectedRoute !== null) {
        state.selectedRoute = null;
        renderCanvas();
      }
    }
  }

  function onCanvasWheel(e) {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;

    // Zoom toward cursor position
    const rect = state.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Data point under cursor before zoom
    const dataX = (mouseX - state.panX) / state.zoom;
    const dataY = (mouseY - state.panY) / state.zoom;

    state.zoom *= factor;
    state.zoom = Math.max(0.3, Math.min(5, state.zoom));

    // Adjust pan so same data point stays under cursor
    state.panX = mouseX - dataX * state.zoom;
    state.panY = mouseY - dataY * state.zoom;

    renderCanvas();
  }

  // ===== Canvas Rendering =====
  function renderCanvas() {
    const ctx = state.ctx;
    const w = state.canvas.width;
    const h = state.canvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(state.panX, state.panY);
    ctx.scale(state.zoom, state.zoom);

    // Draw grid
    drawGrid(ctx);

    if (!state.data) { ctx.restore(); return; }

    // Draw routes (if computed)
    if (state.routes.length > 0) {
      drawRoutes(ctx);
    }

    // Draw delivery points
    drawDeliveryPoints(ctx);

    // Draw warehouses
    drawWarehouses(ctx);

    ctx.restore();
  }

  function drawGrid(ctx) {
    ctx.strokeStyle = 'rgba(42, 63, 95, 0.3)';
    ctx.lineWidth = 0.5;
    for (let x = 0; x < 800; x += 50) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 700);
      ctx.stroke();
    }
    for (let y = 0; y < 700; y += 50) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(800, y);
      ctx.stroke();
    }
  }

  function drawWarehouses(ctx) {
    for (const wh of state.data.warehouses) {
      // Outer glow
      ctx.beginPath();
      ctx.arc(wh.x, wh.y, 18, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(239, 68, 68, 0.15)';
      ctx.fill();

      // Main circle
      ctx.beginPath();
      ctx.arc(wh.x, wh.y, 12, 0, Math.PI * 2);
      ctx.fillStyle = '#ef4444';
      ctx.fill();
      ctx.strokeStyle = '#fca5a5';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Icon
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('W', wh.x, wh.y);

      // Label
      ctx.fillStyle = '#e8edf3';
      ctx.font = '11px sans-serif';
      ctx.fillText(wh.name, wh.x, wh.y + 22);
    }
  }

  function drawDeliveryPoints(ctx) {
    // Pre-compute violated and cold chain delivery point IDs
    var violatedDpIds = {};
    var coldChainDpIds = {};
    for (var ri = 0; ri < state.routes.length; ri++) {
      var route = state.routes[ri];
      if (route.timeWindowViolations) {
        for (var vi = 0; vi < route.timeWindowViolations.length; vi++) {
          var v = route.timeWindowViolations[vi];
          var vOrder = route.orders.find(function(o) { return o.id === v.orderId; });
          if (vOrder) violatedDpIds[vOrder.deliveryPointId] = true;
        }
      }
      for (var oi = 0; oi < route.orders.length; oi++) {
        if (route.orders[oi].coldChain) coldChainDpIds[route.orders[oi].deliveryPointId] = true;
      }
    }

    for (const dp of state.data.deliveryPoints) {
      // Check if this point is part of a route
      let routeColor = null;
      for (let i = 0; i < state.routes.length; i++) {
        const route = state.routes[i];
        for (const order of route.orders) {
          if (order.deliveryPointId === dp.id) {
            routeColor = state.routeColors[i % state.routeColors.length];
            break;
          }
        }
        if (routeColor) break;
      }

      var isViolated = violatedDpIds[dp.id];
      var isColdChain = coldChainDpIds[dp.id];

      // Violation outer glow
      if (isViolated) {
        ctx.beginPath();
        ctx.arc(dp.x, dp.y, 12, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(239, 68, 68, 0.25)';
        ctx.fill();
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Cold chain outer glow (only if not violated)
      if (isColdChain && !isViolated) {
        ctx.beginPath();
        ctx.arc(dp.x, dp.y, 11, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(56, 189, 248, 0.2)';
        ctx.fill();
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Main dot
      ctx.beginPath();
      ctx.arc(dp.x, dp.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = isViolated ? '#ef4444' : (isColdChain ? '#38bdf8' : (routeColor || '#22c55e'));
      ctx.fill();
      ctx.strokeStyle = routeColor ? routeColor + '88' : '#86efac';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Cold chain star marker
      if (isColdChain) {
        ctx.fillStyle = '#38bdf8';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('*', dp.x - 10, dp.y - 8);
      }

      // Label
      ctx.fillStyle = '#8899aa';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(dp.name, dp.x, dp.y + 14);
    }
  }

  function drawRoutes(ctx) {
    const dpMap = {};
    state.data.deliveryPoints.forEach(dp => { dpMap[dp.id] = dp; });
    const whMap = {};
    state.data.warehouses.forEach(wh => { whMap[wh.id] = wh; });

    for (let i = 0; i < state.routes.length; i++) {
      const route = state.routes[i];
      if (route.orders.length === 0) continue;

      const color = state.routeColors[i % state.routeColors.length];
      const warehouse = whMap[route.orders[0].warehouseId];
      if (!warehouse) continue;

      const isSelected = (state.selectedRoute === i);
      const isDimmed = (state.selectedRoute !== null && !isSelected);
      const isLocked = route.locked;

      ctx.strokeStyle = isDimmed ? color + '33' : color;
      ctx.lineWidth = isSelected ? 3.5 : (isLocked ? 3 : 2);
      ctx.globalAlpha = isDimmed ? 0.3 : 1;

      // Locked routes use solid line, others use dashed
      if (isLocked) {
        ctx.setLineDash([]);
      } else {
        ctx.setLineDash([6, 4]);
      }

      ctx.beginPath();
      ctx.moveTo(warehouse.x, warehouse.y);

      for (const order of route.orders) {
        const dp = dpMap[order.deliveryPointId];
        if (dp) {
          ctx.lineTo(dp.x, dp.y);
        }
      }

      // Return to warehouse
      ctx.lineTo(warehouse.x, warehouse.y);
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw lock icon for locked routes
      if (isLocked && !isDimmed) {
        // Draw lock icon as geometric shape
        var lx = warehouse.x + 20;
        var ly = warehouse.y - 20;
        ctx.fillStyle = '#f59e0b';
        // Lock body
        ctx.fillRect(lx - 5, ly - 2, 10, 8);
        // Lock shackle
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(lx, ly - 2, 4, Math.PI, 0);
        ctx.stroke();
      }

      // Draw stop numbers
      let stopNum = 1;
      for (const order of route.orders) {
        const dp = dpMap[order.deliveryPointId];
        if (dp) {
          ctx.fillStyle = isDimmed ? color + '44' : color;
          ctx.beginPath();
          ctx.arc(dp.x + 10, dp.y - 10, 8, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.font = 'bold 8px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(stopNum), dp.x + 10, dp.y - 10);
          stopNum++;
        }
      }

      ctx.globalAlpha = 1;
    }
  }

  // ===== Route Computation =====
  function readObjectives() {
    return {
      minDistance:    { enabled: dom.objMinDist.checked,    weight: parseInt(dom.objMinDistW.value) },
      minViolation:  { enabled: dom.objMinViol.checked,    weight: parseInt(dom.objMinViolW.value) },
      loadBalance:   { enabled: dom.objLoadBal.checked,    weight: parseInt(dom.objLoadBalW.value) },
      driverFairness:{ enabled: dom.objDriverFair.checked, weight: parseInt(dom.objDriverFairW.value) },
      coldChainFirst:{ enabled: dom.objColdChain.checked,  weight: parseInt(dom.objColdChainW.value) }
    };
  }

  function startComputation() {
    if (!state.data) {
      showToast('请先加载数据', 'warning');
      return;
    }

    dom.btnCompute.disabled = true;
    dom.btnCompute.innerHTML = '<span class="spinner"></span> 计算中...';
    dom.canvasInfo.textContent = '正在计算最优路线...';

    var vehicleCount = parseInt(dom.vehicleCount.value);
    var objectives = readObjectives();
    var startTime = parseInt(dom.startTime.value) || 8;

    // Collect locked routes
    var lockedRoutes = [];
    var lockedOrderIds = [];
    for (var i = 0; i < state.routes.length; i++) {
      var route = state.routes[i];
      if (route.locked) {
        lockedRoutes.push(route);
        for (var j = 0; j < route.orders.length; j++) {
          lockedOrderIds.push(route.orders[j].id);
        }
      }
    }

    // Increment computeRequestId to invalidate any in-flight recalc results
    state.computeRequestId++;
    // Bump routeVersion so any pending recalc results become stale
    state.routeVersion++;
    state.pendingRecalcVersions.clear();

    // Send to Web Worker
    state.worker.postMessage({
      type: 'COMPUTE_ROUTES',
      payload: {
        orders: state.data.orders,
        warehouses: state.data.warehouses,
        deliveryPoints: state.data.deliveryPoints,
        drivers: state.data.drivers,
        vehicles: state.data.vehicles,
        vehicleCount: vehicleCount,
        objectives: objectives,
        startTime: startTime,
        requestId: state.computeRequestId,
        lockedRoutes: lockedRoutes,
        lockedOrderIds: lockedOrderIds
      }
    });
  }

  function handleRoutesResult(result) {
    // Stale result guard: discard if requestId doesn't match current
    if (result.requestId !== undefined && result.requestId !== state.computeRequestId) {
      console.log('[Discarded] Stale ROUTES_RESULT, requestId:', result.requestId, 'current:', state.computeRequestId);
      return;
    }

    // Merge locked routes back with newly computed routes
    if (result.lockedRoutes && result.lockedRoutes.length > 0) {
      var allRoutes = [];
      for (var li = 0; li < result.lockedRoutes.length; li++) {
        var lr = result.lockedRoutes[li];
        lr.locked = true;
        allRoutes.push(lr);
      }
      for (var ni = 0; ni < result.routes.length; ni++) {
        var nr = result.routes[ni];
        nr.locked = false;
        allRoutes.push(nr);
      }
      state.routes = allRoutes;
    } else {
      state.routes = result.routes;
    }

    state.unassigned = result.unassigned;
    state.stats = result.stats;

    // Clear pending recalcs — they refer to pre-compute route state
    state.pendingRecalcVersions.clear();
    // Rebuild locked set
    state.lockedRouteIds = new Set();
    for (var ri = 0; ri < state.routes.length; ri++) {
      if (state.routes[ri].locked) state.lockedRouteIds.add(state.routes[ri].id);
    }

    dom.btnCompute.disabled = false;
    dom.btnCompute.innerHTML = '&#9654; 开始调度计算';
    dom.btnExport.disabled = false;

    updateStatsBar();
    renderRouteList();
    renderUnassigned();
    renderCanvas();

    dom.canvasInfo.textContent = '调度完成 - ' + state.stats.activeRoutes + ' 条路线, ' +
      state.stats.assignedOrders + ' 个订单已分配';
    showToast('调度计算完成', 'success');
  }

  function handleRecalcResult(payload) {
    // Stale result guard: discard if routeVersion is older than current
    if (payload.routeVersion !== undefined && payload.routeVersion < state.routeVersion) {
      console.log('[Discarded] Stale RECALC_RESULT, version:', payload.routeVersion, 'current:', state.routeVersion);
      state.pendingRecalcVersions.delete(payload.routeVersion);
      return;
    }

    if (payload.batch && Array.isArray(payload.routes)) {
      // Batch result: apply all routes atomically
      for (const result of payload.routes) {
        const idx = state.routes.findIndex(r => r.id === result.id);
        if (idx >= 0) {
          state.routes[idx] = result;
        }
      }
    } else {
      // Single route result (legacy)
      const idx = state.routes.findIndex(r => r.id === payload.id);
      if (idx >= 0) {
        state.routes[idx] = payload;
      }
    }

    // Clean up pending tracking
    if (payload.routeVersion !== undefined) {
      state.pendingRecalcVersions.delete(payload.routeVersion);
    }

    // Re-aggregate stats from current routes
    recalcGlobalStats();
    updateStatsBar();
    renderRouteList();
    renderCanvas();
  }

  // ===== Stats Bar =====
  function updateStatsBar() {
    if (!state.stats) return;
    dom.statsBar.style.display = 'grid';
    dom.statAssigned.textContent = state.stats.assignedOrders;
    dom.statUnassigned.textContent = state.stats.unassignedOrders;
    dom.statLoadRate.textContent = state.stats.avgLoadRate + '%';
    dom.statRisk.textContent = state.stats.highRiskRoutes;
  }

  // ===== Route List Rendering =====
  function renderRouteList() {
    dom.routeList.innerHTML = '';

    for (let i = 0; i < state.routes.length; i++) {
      const route = state.routes[i];
      if (route.orders.length === 0 && !route.vehicle) continue;

      const card = createRouteCard(route, i);
      dom.routeList.appendChild(card);
    }
  }

  function createRouteCard(route, index) {
    const card = document.createElement('div');
    card.className = 'route-card expanded' + (route.locked ? ' locked' : '');
    card.dataset.routeIndex = index;

    const colorClass = 'route-color-' + ((index % 6) + 1);
    const riskClass = 'risk-' + (route.overtimeRisk || 'unknown');
    const riskText = {
      'low': '低风险',
      'medium': '中风险',
      'high': '高风险',
      'unknown': '未知'
    }[route.overtimeRisk] || '未知';

    var lockIcon = route.locked ? '&#128274;' : '&#128275;';
    var lockClass = route.locked ? 'locked' : '';

    card.innerHTML = `
      <div class="route-card-header ${colorClass}">
        <div>
          <div class="route-title">路线 ${index + 1} - ${route.vehicle ? route.vehicle.name : 'N/A'}</div>
          <div class="route-meta">${route.driver ? route.driver.name : '无司机'} | ${route.orders.length} 个订单</div>
        </div>
        <div class="route-header-right">
          <button class="route-lock-btn ${lockClass}" data-route-id="${route.id}" title="${route.locked ? '解锁路线' : '锁定路线'}">${lockIcon}</button>
          <span class="risk-badge ${riskClass}">${riskText}</span>
        </div>
      </div>
      <div class="route-card-body">
        <div class="route-stats">
          <div class="route-stat"><strong>${route.totalWeight || 0}kg</strong> / ${route.vehicle ? route.vehicle.capacity : 0}kg</div>
          <div class="route-stat">装载率 <strong>${route.loadRate || 0}%</strong></div>
          <div class="route-stat">距离 <strong>${route.totalDistance || 0}</strong></div>
          <div class="route-stat">预计 <strong>${route.estimatedTime || 0}h</strong></div>
          <div class="route-stat">行驶 <strong>${route.drivingTime || 0}h</strong></div>
          <div class="route-stat">休息 <strong>${route.restTime || 0}h</strong></div>
        </div>

        ${route.timeWindowViolations && route.timeWindowViolations.length > 0 ? `
          <div class="violations">
            <h4>时间窗违规 (${route.timeWindowViolations.length})</h4>
            ${route.timeWindowViolations.map(v => `
              <div class="violation-item">${v.orderId}: 预计 ${formatTime(v.expectedArrival)} 到达, 截止 ${formatTime(v.windowEnd)}, 延误 ${v.delay} 分钟</div>
            `).join('')}
          </div>
        ` : ''}

        ${route.constraintWarnings && route.constraintWarnings.length > 0 ? `
          <div class="violations">
            <h4>&#9888; 约束警告 (${route.constraintWarnings.length})</h4>
            ${route.constraintWarnings.map(w => `
              <div class="violation-item">${w}</div>
            `).join('')}
          </div>
        ` : ''}

        ${route.groupingReason && route.groupingReason.length > 0 ? `
          <div class="grouping-reasons">
            <h4>&#128269; 路线分组依据</h4>
            ${route.groupingReason.map(r => `<p>&bull; ${r}</p>`).join('')}
          </div>
        ` : ''}

        <ul class="order-list" data-route-index="${index}">
          ${route.orders.map(order => createOrderItemHTML(order, index, route)).join('')}
        </ul>
      </div>
    `;

    // Bind drag & drop to order items
    setTimeout(() => {
      const orderItems = card.querySelectorAll('.order-item');
      orderItems.forEach(item => {
        item.draggable = true;
        item.addEventListener('dragstart', onOrderDragStart);
        item.addEventListener('dragend', onOrderDragEnd);
      });

      const orderList = card.querySelector('.order-list');
      orderList.addEventListener('dragover', onOrderDragOver);
      orderList.addEventListener('drop', onOrderDrop);
      orderList.addEventListener('dragleave', onOrderDragLeave);

      // Lock button binding
      var lockBtn = card.querySelector('.route-lock-btn');
      if (lockBtn) {
        lockBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          toggleRouteLock(this.dataset.routeId);
        });
      }
    }, 0);

    return card;
  }

  function createOrderItemHTML(order, routeIndex, route) {
    const dp = state.data.deliveryPoints.find(d => d.id === order.deliveryPointId);
    var coldChainBadge = order.coldChain ? '<span class="coldchain-badge" title="冷链">&#10052;</span>' : '';

    var etaHtml = '';
    if (route && route.stopETAs) {
      var etaInfo = route.stopETAs.find(function(s) { return s.orderId === order.id; });
      if (etaInfo) {
        var isViolated = etaInfo.eta > order.timeWindowEnd;
        var etaClass = isViolated ? 'order-eta violated' : 'order-eta';
        etaHtml = '<span class="' + etaClass + '">ETA ' + formatTime(etaInfo.eta) + '</span>';
      }
    }

    return `
      <li class="order-item" data-order-id="${order.id}" data-route-index="${routeIndex}">
        <div>
          ${coldChainBadge}<span class="priority-badge priority-${order.priority}"></span>
          <span class="order-id">${order.id}</span>
          <span class="order-weight">${order.weight}kg</span>
          ${etaHtml}
        </div>
        <span class="order-time">${formatTime(order.timeWindowStart)}-${formatTime(order.timeWindowEnd)}${dp ? ' ' + dp.name : ''}</span>
      </li>
    `;
  }

  // ===== Drag & Drop =====
  function toggleRouteLock(routeId) {
    var route = state.routes.find(function(r) { return r.id === routeId; });
    if (!route) return;

    route.locked = !route.locked;

    if (route.locked) {
      state.lockedRouteIds.add(routeId);
      showToast('路线 ' + routeId + ' 已锁定，重算时将保持不变', 'info');
    } else {
      state.lockedRouteIds.delete(routeId);
      showToast('路线 ' + routeId + ' 已解锁', 'info');
    }

    renderRouteList();
    renderCanvas();
  }

  function onOrderDragStart(e) {
    const orderId = e.target.dataset.orderId;
    const routeIndex = parseInt(e.target.dataset.routeIndex);
    state.dragOrder = orderId;
    state.dragSourceRoute = routeIndex;
    e.target.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', orderId);
  }

  function onOrderDragEnd(e) {
    e.target.classList.remove('dragging');
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    state.dragOrder = null;
    state.dragSourceRoute = null;
  }

  function onOrderDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    e.currentTarget.classList.add('drag-over');
  }

  function onOrderDragLeave(e) {
    e.currentTarget.classList.remove('drag-over');
  }

  function onOrderDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');

    const targetRouteIndex = parseInt(e.currentTarget.dataset.routeIndex);
    const sourceRouteIndex = state.dragSourceRoute;
    const orderId = state.dragOrder;

    if (sourceRouteIndex === null || sourceRouteIndex === targetRouteIndex) return;

    // Move the order
    moveOrderBetweenRoutes(orderId, sourceRouteIndex, targetRouteIndex);
  }

  function moveOrderBetweenRoutes(orderId, fromIndex, toIndex) {
    const fromRoute = state.routes[fromIndex];
    const toRoute = state.routes[toIndex];
    if (!fromRoute || !toRoute) return;

    // Lock constraint: cannot drag out of a locked route
    if (fromRoute.locked) {
      showToast('无法移动: 路线 ' + (fromIndex + 1) + ' 已锁定', 'error');
      return;
    }

    const orderIdx = fromRoute.orders.findIndex(o => o.id === orderId);
    if (orderIdx < 0) return;

    const order = fromRoute.orders[orderIdx];
    const dpMap = buildDpMap();
    const whMap = buildWhMap();
    const startTime = parseInt(dom.startTime.value) || 8;

    // --- Hard constraint: capacity ---
    if (toRoute.totalWeight + order.weight > toRoute.vehicle.capacity) {
      showToast('目标车辆容量不足! 剩余容量: ' + (toRoute.vehicle.capacity - toRoute.totalWeight) + 'kg, 订单重量: ' + order.weight + 'kg', 'error');
      return;
    }

    // --- Simulate the move to check soft constraints ---
    const simFrom = JSON.parse(JSON.stringify(fromRoute));
    const simTo = JSON.parse(JSON.stringify(toRoute));
    simFrom.orders.splice(orderIdx, 1);
    simFrom.totalWeight -= order.weight;
    simTo.orders.push(JSON.parse(JSON.stringify(order)));
    simTo.totalWeight += order.weight;

    localRecalcRoute(simFrom, dpMap, whMap, startTime);
    localRecalcRoute(simTo, dpMap, whMap, startTime);

    // Collect warnings from simulated target route
    const warnings = [];
    const origToViolations = (toRoute.timeWindowViolations || []).length;
    const newToViolations = (simTo.timeWindowViolations || []).length;
    if (newToViolations > origToViolations) {
      warnings.push('目标路线将新增 ' + (newToViolations - origToViolations) + ' 个时间窗违规');
    }

    if (simTo.driver && simTo.estimatedTime > simTo.driver.maxHours) {
      const overtimeMin = Math.round((simTo.estimatedTime - simTo.driver.maxHours) * 60);
      warnings.push('目标路线司机 ' + simTo.driver.name + ' 将超时 ' + overtimeMin + ' 分钟');
    }

    if (simTo.overtimeRisk === 'high' && toRoute.overtimeRisk !== 'high') {
      warnings.push('目标路线超时风险升级为高风险');
    }

    // Show warnings but allow the move
    if (warnings.length > 0) {
      showToast('移动警告: ' + warnings.join('; '), 'warning');
    }

    // --- Apply the move ---
    fromRoute.orders.splice(orderIdx, 1);
    fromRoute.totalWeight -= order.weight;
    toRoute.orders.push(order);
    toRoute.totalWeight += order.weight;

    // Increment route version to invalidate any previous pending recalcs
    state.routeVersion++;
    state.pendingRecalcVersions.add(state.routeVersion);

    // Local recalc for immediate feedback
    localRecalcRoute(fromRoute, dpMap, whMap, startTime);
    localRecalcRoute(toRoute, dpMap, whMap, startTime);

    // Update global stats from locally recalculated routes
    recalcGlobalStats();
    updateStatsBar();
    renderRouteList();
    renderCanvas();

    // Batch send to worker for authoritative recalc
    state.worker.postMessage({
      type: 'RECALCULATE_ROUTES',
      payload: {
        routes: [fromRoute, toRoute],
        dpMap: dpMap,
        whMap: whMap,
        startTime: startTime,
        routeVersion: state.routeVersion
      }
    });

    showToast(orderId + ' 已从路线 ' + (fromIndex + 1) + ' 移至路线 ' + (toIndex + 1), 'info');
  }

  function localRecalcRoute(route, dpMap, whMap, startTime) {
    if (route.orders.length === 0) {
      route.totalDistance = 0;
      route.estimatedTime = 0;
      route.drivingTime = 0;
      route.restTime = 0;
      route.serviceTime = 0;
      route.loadRate = 0;
      route.overtimeRisk = 'low';
      route.overtimeMinutes = 0;
      route.timeWindowViolations = [];
      route.constraintWarnings = [];
      return;
    }

    const warehouse = whMap[route.orders[0].warehouseId];
    if (!warehouse) return;

    // --- Distance: warehouse -> stops -> warehouse (return-to-warehouse) ---
    let totalDist = 0;
    let currentPoint = warehouse;

    for (const order of route.orders) {
      const dp = dpMap[order.deliveryPointId];
      if (dp) {
        const dx = (currentPoint.x || 0) - (dp.x || 0);
        const dy = (currentPoint.y || 0) - (dp.y || 0);
        totalDist += Math.sqrt(dx * dx + dy * dy);
        currentPoint = dp;
      }
    }

    // Return to warehouse
    const rdx = (currentPoint.x || 0) - (warehouse.x || 0);
    const rdy = (currentPoint.y || 0) - (warehouse.y || 0);
    totalDist += Math.sqrt(rdx * rdx + rdy * rdy);

    route.totalDistance = Math.round(totalDist);

    // --- Time calculation ---
    const drivingTime = totalDist / route.vehicle.speed;

    // Driver rest stops (based on driving time only)
    let restTime = 0;
    if (route.driver) {
      const restStops = Math.floor(drivingTime / route.driver.restAfterHours);
      restTime = restStops * route.driver.restDuration;
    }

    const serviceTime = route.orders.length * 0.25;

    route.estimatedTime = Math.round((drivingTime + restTime + serviceTime) * 100) / 100;
    route.drivingTime = Math.round(drivingTime * 100) / 100;
    route.restTime = restTime;
    route.serviceTime = serviceTime;
    route.loadRate = Math.round((route.totalWeight / route.vehicle.capacity) * 100);

    // --- Overtime risk ---
    if (route.driver) {
      route.overtimeRisk = route.estimatedTime > route.driver.maxHours
        ? 'high'
        : route.estimatedTime > route.driver.maxHours * 0.8
          ? 'medium'
          : 'low';
      route.overtimeMinutes = Math.max(0,
        Math.round((route.estimatedTime - route.driver.maxHours) * 60));
    } else {
      route.overtimeRisk = 'unknown';
      route.overtimeMinutes = 0;
    }

    // --- Time window violations ---
    const constraintWarnings = [];
    route.timeWindowViolations = [];
    route.stopETAs = [];
    let currentTime = startTime || 8;
    currentPoint = warehouse;

    for (const order of route.orders) {
      const dp = dpMap[order.deliveryPointId];
      if (dp) {
        const ddx = (currentPoint.x || 0) - (dp.x || 0);
        const ddy = (currentPoint.y || 0) - (dp.y || 0);
        const dist = Math.sqrt(ddx * ddx + ddy * ddy);
        const travelTime = dist / route.vehicle.speed;
        currentTime += travelTime;

        var waitTime = 0;
        if (currentTime < order.timeWindowStart) {
          waitTime = Math.round((order.timeWindowStart - currentTime) * 60);
          currentTime = order.timeWindowStart; // Wait until window opens
        }

        route.stopETAs.push({
          orderId: order.id,
          eta: Math.round(currentTime * 100) / 100,
          waitTime: waitTime
        });

        if (currentTime > order.timeWindowEnd) {
          route.timeWindowViolations.push({
            orderId: order.id,
            expectedArrival: Math.round(currentTime * 100) / 100,
            windowEnd: order.timeWindowEnd,
            delay: Math.round((currentTime - order.timeWindowEnd) * 60)
          });
        }

        currentTime += 0.25; // Service time at stop
        currentPoint = dp;
      }
    }

    // Constraint warnings
    if (route.totalWeight > route.vehicle.capacity) {
      constraintWarnings.push('超载: ' + route.totalWeight + 'kg > ' + route.vehicle.capacity + 'kg');
    }
    if (route.overtimeRisk === 'high') {
      constraintWarnings.push('超时高风险: ' + route.estimatedTime + 'h > ' + (route.driver ? route.driver.maxHours : '?') + 'h');
    }
    if (route.timeWindowViolations.length > 0) {
      constraintWarnings.push('时间窗违规: ' + route.timeWindowViolations.length + ' 个订单');
    }
    route.constraintWarnings = constraintWarnings;
  }

  // ===== Unassigned Orders =====
  function renderUnassigned() {
    if (!state.unassigned || state.unassigned.length === 0) {
      dom.unassignedSection.style.display = 'none';
      return;
    }

    dom.unassignedSection.style.display = 'block';
    dom.unassignedList.innerHTML = '';

    for (const item of state.unassigned) {
      const div = document.createElement('div');
      div.className = 'unassigned-item';
      var coldBadge = item.order.coldChain ? '<span class="coldchain-badge" title="冷链">&#10052;</span>' : '';
      div.innerHTML = `
        <span class="order-id">${item.order.id}</span>
        ${coldBadge}
        <span class="order-weight">${item.order.weight}kg</span>
        <div class="unassigned-reason">${item.reasons.join('<br>')}</div>
      `;
      dom.unassignedList.appendChild(div);
    }
  }

  // ===== Import / Export =====
  function closeImportModal() {
    dom.importModal.style.display = 'none';
    dom.importTextarea.value = '';
  }

  function handleFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(ev) {
      try {
        const data = JSON.parse(ev.target.result);
        applyImportedData(data);
        closeImportModal();
        showToast('文件导入成功: ' + file.name, 'success');
      } catch (err) {
        showToast('JSON 解析失败: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function handleImportConfirm() {
    const text = dom.importTextarea.value.trim();
    if (!text) {
      showToast('请输入或选择数据', 'warning');
      return;
    }

    try {
      const data = JSON.parse(text);
      applyImportedData(data);
      closeImportModal();
      showToast('数据导入成功', 'success');
    } catch (err) {
      showToast('JSON 解析失败: ' + err.message, 'error');
    }
  }

  function applyImportedData(data) {
    // Merge with existing data
    if (data.orders && Array.isArray(data.orders)) {
      state.data.orders = data.orders;
    }
    if (data.warehouses && Array.isArray(data.warehouses)) {
      state.data.warehouses = data.warehouses;
    }
    if (data.deliveryPoints && Array.isArray(data.deliveryPoints)) {
      state.data.deliveryPoints = data.deliveryPoints;
    }
    if (data.drivers && Array.isArray(data.drivers)) {
      state.data.drivers = data.drivers;
    }
    if (data.vehicles && Array.isArray(data.vehicles)) {
      state.data.vehicles = data.vehicles;
    }

    updateOverview();
    autoFitCanvas();
    renderCanvas();

    // Reset routes
    state.routes = [];
    state.unassigned = [];
    state.stats = null;
    dom.routeList.innerHTML = '<div class="empty-state">数据已更新，请重新执行调度计算</div>';
    dom.unassignedSection.style.display = 'none';
    dom.statsBar.style.display = 'none';
    dom.btnExport.disabled = true;
  }

  function exportPlan() {
    if (!state.routes || state.routes.length === 0) {
      showToast('没有可导出的调度方案', 'warning');
      return;
    }

    const plan = {
      exportTime: new Date().toISOString(),
      parameters: {
        vehicleCount: parseInt(dom.vehicleCount.value),
        objectives: readObjectives(),
        startTime: dom.startTime.value
      },
      stats: state.stats,
      routes: state.routes.map((r, i) => ({
        routeIndex: i + 1,
        locked: r.locked || false,
        vehicle: r.vehicle,
        driver: r.driver,
        orders: r.orders,
        totalWeight: r.totalWeight,
        loadRate: r.loadRate,
        totalDistance: r.totalDistance,
        estimatedTime: r.estimatedTime,
        drivingTime: r.drivingTime,
        restTime: r.restTime,
        overtimeRisk: r.overtimeRisk,
        overtimeMinutes: r.overtimeMinutes,
        timeWindowViolations: r.timeWindowViolations,
        stopETAs: r.stopETAs || [],
        groupingReasons: r.groupingReason
      })),
      unassigned: state.unassigned
    };

    const blob = new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dispatch-plan-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);

    showToast('调度方案已导出', 'success');
  }

  // ===== Save / Load (localStorage) =====
  function savePlan() {
    if (!state.routes || state.routes.length === 0) {
      showToast('没有可保存的调度方案', 'warning');
      return;
    }

    const saveData = {
      timestamp: new Date().toISOString(),
      parameters: {
        vehicleCount: parseInt(dom.vehicleCount.value),
        objectives: readObjectives(),
        startTime: dom.startTime.value
      },
      data: state.data,
      routes: state.routes,
      unassigned: state.unassigned,
      stats: state.stats
    };

    try {
      localStorage.setItem('deliveryDispatch_lastPlan', JSON.stringify(saveData));
      showToast('规划已保存到本地存储', 'success');
    } catch (err) {
      showToast('保存失败: ' + err.message, 'error');
    }
  }

  function loadPlan() {
    const saved = localStorage.getItem('deliveryDispatch_lastPlan');
    if (!saved) {
      showToast('没有找到已保存的规划', 'warning');
      return;
    }

    try {
      const saveData = JSON.parse(saved);

      // Restore data
      state.data = saveData.data;
      state.routes = saveData.routes;
      state.unassigned = saveData.unassigned;
      state.stats = saveData.stats;

      // Restore parameters
      if (saveData.parameters) {
        dom.vehicleCount.value = saveData.parameters.vehicleCount;
        dom.vehicleCountLabel.textContent = saveData.parameters.vehicleCount;
        dom.startTime.value = saveData.parameters.startTime;

        // Restore objectives if saved; handle old format with strategy
        if (saveData.parameters.objectives) {
          var obj = saveData.parameters.objectives;
          dom.objMinDist.checked = obj.minDistance ? obj.minDistance.enabled : false;
          dom.objMinDistW.value = obj.minDistance ? obj.minDistance.weight : 50;
          dom.objMinDistWL.textContent = dom.objMinDistW.value;
          dom.objMinViol.checked = obj.minViolation ? obj.minViolation.enabled : false;
          dom.objMinViolW.value = obj.minViolation ? obj.minViolation.weight : 50;
          dom.objMinViolWL.textContent = dom.objMinViolW.value;
          dom.objLoadBal.checked = obj.loadBalance ? obj.loadBalance.enabled : false;
          dom.objLoadBalW.value = obj.loadBalance ? obj.loadBalance.weight : 50;
          dom.objLoadBalWL.textContent = dom.objLoadBalW.value;
          dom.objDriverFair.checked = obj.driverFairness ? obj.driverFairness.enabled : false;
          dom.objDriverFairW.value = obj.driverFairness ? obj.driverFairness.weight : 50;
          dom.objDriverFairWL.textContent = dom.objDriverFairW.value;
          dom.objColdChain.checked = obj.coldChainFirst ? obj.coldChainFirst.enabled : false;
          dom.objColdChainW.value = obj.coldChainFirst ? obj.coldChainFirst.weight : 50;
          dom.objColdChainWL.textContent = dom.objColdChainW.value;
        } else if (saveData.parameters.strategy) {
          // Legacy: just set minDistance enabled
          dom.objMinDist.checked = true;
          dom.strategy.value = saveData.parameters.strategy;
        }
      }

      // Restore locked route IDs
      state.lockedRouteIds = new Set();
      for (var ri = 0; ri < state.routes.length; ri++) {
        if (state.routes[ri].locked) state.lockedRouteIds.add(state.routes[ri].id);
      }

      // Update UI
      updateOverview();
      updateStatsBar();
      renderRouteList();
      renderUnassigned();
      renderCanvas();
      dom.btnExport.disabled = false;

      const savedDate = new Date(saveData.timestamp).toLocaleString('zh-CN');
      showToast('已加载上次规划 (保存于 ' + savedDate + ')', 'success');
      dom.canvasInfo.textContent = '已加载规划 - ' + savedDate;
    } catch (err) {
      showToast('加载失败: ' + err.message, 'error');
    }
  }

  // ===== Utilities =====
  function recalcGlobalStats() {
    if (!state.routes || !state.stats) return;
    let assignedCount = 0;
    let totalWeight = 0;
    let totalCapacity = 0;
    let totalDistance = 0;
    let totalEstimatedTime = 0;
    let highRiskCount = 0;
    let violationCount = 0;

    for (const route of state.routes) {
      assignedCount += route.orders.length;
      totalWeight += route.totalWeight || 0;
      totalCapacity += route.vehicle ? route.vehicle.capacity : 0;
      totalDistance += route.totalDistance || 0;
      totalEstimatedTime += route.estimatedTime || 0;
      if (route.overtimeRisk === 'high') highRiskCount++;
      violationCount += (route.timeWindowViolations || []).length;
    }

    state.stats.assignedOrders = assignedCount;
    state.stats.totalWeight = totalWeight;
    state.stats.totalCapacity = totalCapacity;
    state.stats.avgLoadRate = totalCapacity > 0 ? Math.round((totalWeight / totalCapacity) * 100) : 0;
    state.stats.totalDistance = Math.round(totalDistance);
    state.stats.totalEstimatedTime = Math.round(totalEstimatedTime * 100) / 100;
    state.stats.highRiskRoutes = highRiskCount;
    state.stats.timeWindowViolations = violationCount;
    state.stats.activeRoutes = state.routes.filter(r => r.orders.length > 0).length;
  }

  function formatTime(hours) {
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }

  function showToast(message, type) {
    type = type || 'info';
    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.textContent = message;
    dom.toastContainer.appendChild(toast);
    setTimeout(() => {
      if (toast.parentElement) toast.parentElement.removeChild(toast);
    }, 3000);
  }

  // ===== Start =====
  document.addEventListener('DOMContentLoaded', init);

})();
