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
    panStartX: 0,
    panStartY: 0,

    // Drag & drop
    dragOrder: null,
    dragSourceRoute: null,

    // Version tracking for async isolation
    routeVersion: 0,
    _computeRequestId: null,
    _pendingRecalcIds: {},

    // Route colors
    routeColors: ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4']
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
      const { type, payload, requestId } = e.data;
      if (type === 'ROUTES_RESULT') {
        handleRoutesResult(payload, requestId);
      } else if (type === 'RECALC_RESULT') {
        handleRecalcResult(payload, requestId);
      }
    };
    state.worker.onerror = function(err) {
      console.error('Worker error:', err);
      showToast('Worker 计算出错: ' + err.message, 'error');
    };
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
    state.canvas.addEventListener('mouseup', onCanvasMouseUp);
    state.canvas.addEventListener('mouseleave', onCanvasMouseUp);
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

  function onCanvasMouseDown(e) {
    state.isPanning = true;
    state.panStartX = e.clientX - state.panX;
    state.panStartY = e.clientY - state.panY;
  }

  function onCanvasMouseMove(e) {
    if (state.isPanning) {
      state.panX = e.clientX - state.panStartX;
      state.panY = e.clientY - state.panStartY;
      renderCanvas();
    }
  }

  function onCanvasMouseUp() {
    state.isPanning = false;
  }

  function onCanvasWheel(e) {
    e.preventDefault();
    const rect = state.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // World-space position under cursor before zoom
    const worldX = (mouseX - state.panX) / state.zoom;
    const worldY = (mouseY - state.panY) / state.zoom;

    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.max(0.3, Math.min(5, state.zoom * factor));

    // Adjust pan so the same world point stays under the cursor
    state.panX = mouseX - worldX * newZoom;
    state.panY = mouseY - worldY * newZoom;
    state.zoom = newZoom;

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

      ctx.beginPath();
      ctx.arc(dp.x, dp.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = routeColor || '#22c55e';
      ctx.fill();
      ctx.strokeStyle = routeColor ? routeColor + '88' : '#86efac';
      ctx.lineWidth = 1.5;
      ctx.stroke();

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

      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
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

      // Draw stop numbers
      let stopNum = 1;
      for (const order of route.orders) {
        const dp = dpMap[order.deliveryPointId];
        if (dp) {
          ctx.fillStyle = color;
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
    }
  }

  // ===== Route Computation =====
  function startComputation() {
    if (!state.data) {
      showToast('请先加载数据', 'warning');
      return;
    }

    dom.btnCompute.disabled = true;
    dom.btnCompute.innerHTML = '<span class="spinner"></span> 计算中...';
    dom.canvasInfo.textContent = '正在计算最优路线...';

    const vehicleCount = parseInt(dom.vehicleCount.value);
    const strategy = dom.strategy.value;

    // Increment version to invalidate any in-flight results
    state.routeVersion++;
    const requestId = 'compute_' + state.routeVersion;
    state._computeRequestId = requestId;
    state._pendingRecalcIds = {};

    // Send to Web Worker
    state.worker.postMessage({
      type: 'COMPUTE_ROUTES',
      requestId: requestId,
      payload: {
        orders: state.data.orders,
        warehouses: state.data.warehouses,
        deliveryPoints: state.data.deliveryPoints,
        drivers: state.data.drivers,
        vehicles: state.data.vehicles,
        vehicleCount: vehicleCount,
        strategy: strategy
      }
    });
  }

  function handleRoutesResult(result, requestId) {
    // Discard stale results from previous computation
    if (requestId !== state._computeRequestId) {
      console.warn('Discarding stale ROUTES_RESULT, requestId:', requestId, 'current:', state._computeRequestId);
      return;
    }

    state.routes = result.routes;
    state.unassigned = result.unassigned;
    state.stats = result.stats;

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

  function handleRecalcResult(result, requestId) {
    // Discard stale recalc results
    if (requestId && state._pendingRecalcIds[result.id] !== requestId) {
      console.warn('Discarding stale RECALC_RESULT for route:', result.id, 'requestId:', requestId);
      return;
    }
    delete state._pendingRecalcIds[result.id];

    // Update the specific route
    const idx = state.routes.findIndex(r => r.id === result.id);
    if (idx >= 0) {
      state.routes[idx] = result;
      recalcGlobalStats();
      updateStatsBar();
      renderRouteList();
      renderCanvas();
    }
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
    card.className = 'route-card expanded';
    card.dataset.routeIndex = index;

    const colorClass = 'route-color-' + ((index % 6) + 1);
    const riskClass = 'risk-' + (route.overtimeRisk || 'unknown');
    const riskText = {
      'low': '低风险',
      'medium': '中风险',
      'high': '高风险',
      'unknown': '未知'
    }[route.overtimeRisk] || '未知';

    card.innerHTML = `
      <div class="route-card-header ${colorClass}">
        <div>
          <div class="route-title">路线 ${index + 1} - ${route.vehicle ? route.vehicle.name : 'N/A'}</div>
          <div class="route-meta">${route.driver ? route.driver.name : '无司机'} | ${route.orders.length} 个订单</div>
        </div>
        <span class="risk-badge ${riskClass}">${riskText}</span>
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

        ${route.groupingReason && route.groupingReason.length > 0 ? `
          <div class="grouping-reasons">
            <h4>&#128269; 路线分组依据</h4>
            ${route.groupingReason.map(r => `<p>&bull; ${r}</p>`).join('')}
          </div>
        ` : ''}

        <ul class="order-list" data-route-index="${index}">
          ${route.orders.map(order => createOrderItemHTML(order, index)).join('')}
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
    }, 0);

    return card;
  }

  function createOrderItemHTML(order, routeIndex) {
    const dp = state.data.deliveryPoints.find(d => d.id === order.deliveryPointId);
    return `
      <li class="order-item" data-order-id="${order.id}" data-route-index="${routeIndex}">
        <div>
          <span class="priority-badge priority-${order.priority}"></span>
          <span class="order-id">${order.id}</span>
          <span class="order-weight">${order.weight}kg</span>
        </div>
        <span class="order-time">${formatTime(order.timeWindowStart)}-${formatTime(order.timeWindowEnd)}${dp ? ' ' + dp.name : ''}</span>
      </li>
    `;
  }

  // ===== Drag & Drop =====
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

    const orderIdx = fromRoute.orders.findIndex(o => o.id === orderId);
    if (orderIdx < 0) return;

    const order = fromRoute.orders[orderIdx];

    // Check capacity
    if (toRoute.totalWeight + order.weight > toRoute.vehicle.capacity) {
      showToast('目标车辆容量不足! 剩余容量: ' + (toRoute.vehicle.capacity - toRoute.totalWeight) + 'kg, 订单重量: ' + order.weight + 'kg', 'error');
      return;
    }

    // Simulate the target route with the new order to validate constraints
    const violations = validateMoveConstraints(order, toRoute);
    if (violations.length > 0) {
      showToast('无法移动: ' + violations.join('; '), 'error');
      return;
    }

    // Move order
    fromRoute.orders.splice(orderIdx, 1);
    fromRoute.totalWeight -= order.weight;
    toRoute.orders.push(order);
    toRoute.totalWeight += order.weight;

    // Recalculate both routes
    recalcRoute(fromRoute);
    recalcRoute(toRoute);

    // Update global stats
    recalcGlobalStats();

    // Update UI
    updateStatsBar();
    renderRouteList();
    renderUnassigned();
    renderCanvas();

    showToast(orderId + ' 已从路线 ' + (fromIndex + 1) + ' 移至路线 ' + (toIndex + 1), 'info');
  }

  function validateMoveConstraints(order, targetRoute) {
    const violations = [];
    const dpMap = {};
    state.data.deliveryPoints.forEach(dp => { dpMap[dp.id] = dp; });
    const whMap = {};
    state.data.warehouses.forEach(wh => { whMap[wh.id] = wh; });

    // Build a simulated order list with the new order appended
    const simOrders = [...targetRoute.orders, order];
    const warehouse = whMap[simOrders[0].warehouseId];
    if (!warehouse) return violations;

    const startTime = parseInt(dom.startTime.value) || 8;

    // Simulate traversal to check time windows and driver constraints
    let currentTime = startTime;
    let currentPoint = warehouse;
    let totalDist = 0;

    for (const o of simOrders) {
      const dp = dpMap[o.deliveryPointId];
      if (!dp) continue;

      const dx = (currentPoint.x || 0) - (dp.x || 0);
      const dy = (currentPoint.y || 0) - (dp.y || 0);
      const dist = Math.sqrt(dx * dx + dy * dy);
      totalDist += dist;

      const travelTime = dist / targetRoute.vehicle.speed;
      currentTime += travelTime;

      if (currentTime < o.timeWindowStart) currentTime = o.timeWindowStart;

      // Check time window violation for the moved order specifically
      if (o.id === order.id && currentTime > o.timeWindowEnd) {
        const delay = Math.round((currentTime - o.timeWindowEnd) * 60);
        violations.push('订单 ' + o.id + ' 将延误 ' + delay + ' 分钟 (预计 ' + formatTime(currentTime) + ' 到达, 截止 ' + formatTime(o.timeWindowEnd) + ')');
      }

      currentTime += 0.25; // service time
      currentPoint = dp;
    }

    // Return to warehouse distance
    const retDx = (currentPoint.x || 0) - (warehouse.x || 0);
    const retDy = (currentPoint.y || 0) - (warehouse.y || 0);
    totalDist += Math.sqrt(retDx * retDx + retDy * retDy);
    const returnTravelTime = Math.sqrt(retDx * retDx + retDy * retDy) / targetRoute.vehicle.speed;
    const returnTime = currentTime + returnTravelTime;

    // Driver constraint checks
    if (targetRoute.driver) {
      const drivingTime = totalDist / targetRoute.vehicle.speed;
      const restStops = Math.floor(drivingTime / targetRoute.driver.restAfterHours);
      const restTime = restStops * targetRoute.driver.restDuration;
      const serviceTime = simOrders.length * 0.25;
      const estimatedTime = drivingTime + restTime + serviceTime;

      // Check driver max hours
      if (estimatedTime > targetRoute.driver.maxHours) {
        const overtime = Math.round((estimatedTime - targetRoute.driver.maxHours) * 60);
        violations.push('司机将超时 ' + overtime + ' 分钟 (预计 ' + Math.round(estimatedTime * 100) / 100 + 'h, 上限 ' + targetRoute.driver.maxHours + 'h)');
      }

      // Check return-to-warehouse: driver must return within maxHours from start
      const totalWithReturn = estimatedTime + returnTravelTime;
      if (totalWithReturn > targetRoute.driver.maxHours) {
        const lateMinutes = Math.round((totalWithReturn - targetRoute.driver.maxHours) * 60);
        violations.push('返仓后将超出工时 ' + lateMinutes + ' 分钟');
      }
    }

    return violations;
  }

  function recalcRoute(route) {
    const dpMap = {};
    state.data.deliveryPoints.forEach(dp => { dpMap[dp.id] = dp; });
    const whMap = {};
    state.data.warehouses.forEach(wh => { whMap[wh.id] = wh; });

    // Generate unique requestId for this route recalc
    state.routeVersion++;
    const requestId = 'recalc_' + route.id + '_' + state.routeVersion;
    state._pendingRecalcIds[route.id] = requestId;

    // Send to worker for recalculation
    state.worker.postMessage({
      type: 'RECALCULATE_ROUTE',
      requestId: requestId,
      payload: { route, dpMap, whMap }
    });

    // Also do local recalc for immediate feedback
    localRecalcRoute(route, dpMap, whMap);
  }

  function localRecalcRoute(route, dpMap, whMap) {
    if (route.orders.length === 0) {
      route.totalDistance = 0;
      route.estimatedTime = 0;
      route.drivingTime = 0;
      route.restTime = 0;
      route.loadRate = 0;
      route.overtimeRisk = 'low';
      route.timeWindowViolations = [];
      return;
    }

    const warehouse = whMap[route.orders[0].warehouseId];
    if (!warehouse) return;

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

    const dx = (currentPoint.x || 0) - (warehouse.x || 0);
    const dy = (currentPoint.y || 0) - (warehouse.y || 0);
    totalDist += Math.sqrt(dx * dx + dy * dy);

    route.totalDistance = Math.round(totalDist);

    const drivingTime = totalDist / route.vehicle.speed;
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

    if (route.driver) {
      route.overtimeRisk = route.estimatedTime > route.driver.maxHours
        ? 'high'
        : route.estimatedTime > route.driver.maxHours * 0.8
          ? 'medium'
          : 'low';
      route.overtimeMinutes = Math.max(0,
        Math.round((route.estimatedTime - route.driver.maxHours) * 60));
    }

    // Time window check
    route.timeWindowViolations = [];
    let currentTime = parseInt(dom.startTime.value) || 8;
    currentPoint = warehouse;
    for (const order of route.orders) {
      const dp = dpMap[order.deliveryPointId];
      if (dp) {
        const ddx = (currentPoint.x || 0) - (dp.x || 0);
        const ddy = (currentPoint.y || 0) - (dp.y || 0);
        const dist = Math.sqrt(ddx * ddx + ddy * ddy);
        const travelTime = dist / route.vehicle.speed;
        currentTime += travelTime;
        if (currentTime < order.timeWindowStart) currentTime = order.timeWindowStart;
        if (currentTime > order.timeWindowEnd) {
          route.timeWindowViolations.push({
            orderId: order.id,
            expectedArrival: Math.round(currentTime * 100) / 100,
            windowEnd: order.timeWindowEnd,
            delay: Math.round((currentTime - order.timeWindowEnd) * 60)
          });
        }
        currentTime += 0.25;
        currentPoint = dp;
      }
    }
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
      div.innerHTML = `
        <span class="order-id">${item.order.id}</span>
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
    // Invalidate any in-flight worker results
    state.routeVersion++;
    state._computeRequestId = null;
    state._pendingRecalcIds = {};
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
        strategy: dom.strategy.value,
        startTime: dom.startTime.value
      },
      stats: state.stats,
      routes: state.routes.map((r, i) => ({
        routeIndex: i + 1,
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
        strategy: dom.strategy.value,
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
        dom.strategy.value = saveData.parameters.strategy;
        dom.startTime.value = saveData.parameters.startTime;
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
    state.stats.unassignedOrders = (state.stats.totalOrders || 0) - assignedCount;
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
