// ============================================================
// 配送调度演示系统 - 主应用
// ============================================================

(function () {
  'use strict';

  // ---- 路线颜色 ----
  const ROUTE_COLORS = ['#4a9eff', '#ff6b6b', '#51cf66', '#ffd43b', '#cc5de8'];

  // ---- 全局状态 ----
  const state = {
    rawData: null,        // 原始加载数据
    result: null,         // 规划结果 { routes, unassigned, invalid, stats }
    history: [],          // 回退历史（序列化快照）
    hoveredStop: null,    // 鼠标悬停的站点
    canvasOffset: { x: 40, y: 40 },
    canvasScale: 1,
  };

  // ---- DOM 引用 ----
  const $ = id => document.getElementById(id);
  const canvas = $('mapCanvas');
  const ctx = canvas.getContext('2d');
  const overlay = $('computingOverlay');

  // ---- Worker ----
  const worker = new Worker('worker.js');

  worker.onmessage = function (e) {
    const { type, payload } = e.data;
    if (type === 'plan-result') {
      state.result = payload;
      state.history = [];
      overlay.classList.remove('show');
      enableButtons();
      renderAll();
    } else if (type === 'recalc-result') {
      // 单路线重算结果
      const updated = payload;
      const idx = state.result.routes.findIndex(r => r.id === updated.id);
      if (idx >= 0) state.result.routes[idx] = updated;
      renderAll();
    }
  };

  // ---- 数据加载 ----

  function loadData(data) {
    state.rawData = data;
    state.result = null;
    state.history = [];
    $('btnPlan').disabled = false;
    renderDataOverview();
    renderRouteList();
    renderStats();
    renderUnassigned();
    renderInvalid();
    drawCanvas();
  }

  // 加载示例数据
  $('btnLoadSample').addEventListener('click', () => {
    fetch('sample-data.json')
      .then(r => r.json())
      .then(data => loadData(data))
      .catch(err => alert('加载示例数据失败: ' + err.message));
  });

  // 导入文件
  $('fileImport').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!data.warehouse || !data.orders) throw new Error('缺少 warehouse 或 orders 字段');
        loadData(data);
      } catch (err) {
        alert('导入失败: ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  // ---- 规划 ----

  $('btnPlan').addEventListener('click', () => {
    if (!state.rawData) return;
    overlay.classList.add('show');
    worker.postMessage({
      type: 'plan',
      payload: {
        warehouse: state.rawData.warehouse,
        deliveryPoints: state.rawData.deliveryPoints,
        orders: state.rawData.orders,
        vehicles: state.rawData.vehicles,
        drivers: state.rawData.drivers,
        strategy: $('selStrategy').value,
        vehicleCount: parseInt($('selVehicleCount').value),
      },
    });
  });

  // ---- 按钮状态 ----

  function enableButtons() {
    $('btnExport').disabled = false;
    $('btnSave').disabled = false;
    $('btnUndo').disabled = state.history.length === 0;
  }

  // ---- 渲染总入口 ----

  function renderAll() {
    renderRouteList();
    renderStats();
    renderUnassigned();
    renderInvalid();
    drawCanvas();
  }

  // ---- 数据概览 ----

  function renderDataOverview() {
    const d = state.rawData;
    if (!d) {
      $('dataContent').innerHTML = '<p class="empty-hint">未加载数据</p>';
      return;
    }
    $('dataContent').innerHTML = `
      <div class="data-row"><span>仓库</span><span>${d.warehouse.name}</span></div>
      <div class="data-row"><span>配送点</span><span>${d.deliveryPoints.length} 个</span></div>
      <div class="data-row"><span>订单</span><span>${d.orders.length} 单</span></div>
      <div class="data-row"><span>车辆</span><span>${d.vehicles.length} 辆</span></div>
      <div class="data-row"><span>司机</span><span>${d.drivers.length} 人</span></div>
    `;
  }

  // ---- 统计 ----

  function renderStats() {
    const r = state.result;
    if (!r) {
      $('statsContent').innerHTML = '<p class="empty-hint">暂无数据</p>';
      return;
    }
    const s = r.stats;
    const strategyNames = {
      nearest_first: '最近优先',
      urgent_first: '紧急优先',
      cluster: '区域聚类',
      balanced: '均衡负载',
    };
    const totalDist = r.routes.reduce((a, rt) => a + rt.totalDistance, 0);
    $('statsContent').innerHTML = `
      <span class="stat-label">策略</span><span class="stat-value">${strategyNames[s.strategy] || s.strategy}</span>
      <span class="stat-label">总订单</span><span class="stat-value">${s.totalOrders}</span>
      <span class="stat-label">已分配</span><span class="stat-value" style="color:var(--success)">${s.assignedCount}</span>
      <span class="stat-label">未分配</span><span class="stat-value" style="color:var(--warning)">${s.unassignedCount}</span>
      <span class="stat-label">异常</span><span class="stat-value" style="color:var(--danger)">${s.invalidCount}</span>
      <span class="stat-label">路线数</span><span class="stat-value">${r.routes.filter(rt => rt.stops.length > 0).length}</span>
      <span class="stat-label">总里程</span><span class="stat-value">${totalDist.toFixed(1)} km</span>
      <span class="stat-label">计算耗时</span><span class="stat-value">${s.computeTimeMs} ms</span>
    `;
  }

  // ---- 未分配订单 ----

  function renderUnassigned() {
    const r = state.result;
    const list = r ? r.unassigned : [];
    $('unassignedCount').textContent = list.length;
    if (list.length === 0) {
      $('unassignedList').innerHTML = '';
      return;
    }
    $('unassignedList').innerHTML = list.map(o => `
      <div class="order-item" draggable="true" data-order-id="${o.id}" data-source="unassigned">
        <div class="order-id">${o.id} - ${o.dpName || '未知'}</div>
        <div class="order-desc">${o.description} | ${o.weight}kg | ${o.timeWindowStart}-${o.timeWindowEnd}</div>
        <div class="order-problems">${o.problems.join('；')}</div>
      </div>
    `).join('');
    bindUnassignedDrag();
  }

  // ---- 异常订单 ----

  function renderInvalid() {
    const r = state.result;
    const list = r ? r.invalid : [];
    $('invalidCount').textContent = list.length;
    if (list.length === 0) {
      $('invalidList').innerHTML = '';
      return;
    }
    $('invalidList').innerHTML = list.map(o => `
      <div class="order-item">
        <div class="order-id">${o.id}</div>
        <div class="order-desc">${o.description} | ${o.weight}kg</div>
        <div class="order-problems">${o.problems.join('；')}</div>
      </div>
    `).join('');
  }

  // ---- 路线列表 ----

  function renderRouteList() {
    const r = state.result;
    if (!r || r.routes.length === 0) {
      $('routeList').innerHTML = '<p class="empty-hint">请先加载数据并规划路线</p>';
      return;
    }

    $('routeList').innerHTML = r.routes.map((route, ri) => {
      const color = ROUTE_COLORS[ri % ROUTE_COLORS.length];
      const stopsHtml = route.stops.map((stop, si) => `
        <div class="route-stop" draggable="true"
             data-route-id="${route.id}" data-order-id="${stop.orderId}" data-stop-idx="${si}">
          <span class="stop-seq" style="background:${color}">${si + 1}</span>
          <div class="stop-detail">
            <div class="stop-name">${stop.dpName} (${stop.orderId})</div>
            <div class="stop-time">${stop.arriveTime} 到达 | ${stop.timeWindowStart}-${stop.timeWindowEnd} | ${stop.weight}kg</div>
            <div class="stop-reason">${stop.reason || ''}</div>
          </div>
          <span class="stop-risk risk-${stop.risk || 'ok'}">${riskLabel(stop.risk)}</span>
        </div>
      `).join('');

      const metricsHtml = route.stops.length > 0 ? `
        <div class="route-metrics">
          <span class="metric-label">总里程</span><span class="metric-value">${route.totalDistance.toFixed(1)} km</span>
          <span class="metric-label">总耗时</span><span class="metric-value">${Math.round(route.totalTime)} 分钟</span>
          <span class="metric-label">载重率</span><span class="metric-value">${(route.loadRateWeight * 100).toFixed(0)}%</span>
          <span class="metric-label">载体积率</span><span class="metric-value">${(route.loadRateVolume * 100).toFixed(0)}%</span>
          <span class="metric-label">载重</span><span class="metric-value">${route.totalWeight}/${route.capacityWeight} kg</span>
          <span class="metric-label">预计返回</span><span class="metric-value">${route.returnTime || '--:--'}</span>
        </div>
      ` : '';

      const warningsHtml = route.warnings.length > 0 ? `
        <div class="route-warnings">${route.warnings.map(w => `<div class="warning-item">${w}</div>`).join('')}</div>
      ` : '';

      return `
        <div class="route-card" data-route-id="${route.id}">
          <div class="route-header" data-route-idx="${ri}">
            <div class="route-color-bar" style="background:${color}"></div>
            <div class="route-info">
              <div class="route-title">${route.vehicleName} - ${route.driverName}</div>
              <div class="route-meta">${route.stops.length} 站 | ${route.totalWeight}kg | ${route.totalDistance.toFixed(1)}km</div>
            </div>
            <span class="route-toggle">&#9654;</span>
          </div>
          <div class="route-stops" data-route-id="${route.id}">
            ${stopsHtml}
          </div>
          ${metricsHtml}
          ${warningsHtml}
        </div>
      `;
    }).join('');

    // 绑定折叠/展开
    document.querySelectorAll('.route-header').forEach(header => {
      header.addEventListener('click', () => {
        const idx = header.dataset.routeIdx;
        const card = header.closest('.route-card');
        const stops = card.querySelector('.route-stops');
        const toggle = header.querySelector('.route-toggle');
        stops.classList.toggle('open');
        toggle.classList.toggle('open');
      });
    });

    bindStopDrag();
  }

  function riskLabel(risk) {
    if (risk === 'overdue') return '超时';
    if (risk === 'tight') return '紧迫';
    return '正常';
  }

  // ---- Canvas 绘制 ----

  function drawCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const W = rect.width;
    const H = rect.height;

    ctx.fillStyle = '#1a1d23';
    ctx.fillRect(0, 0, W, H);

    // 网格
    ctx.strokeStyle = '#2a2f38';
    ctx.lineWidth = 0.5;
    for (let x = 0; x < W; x += 50) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y < H; y += 50) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    if (!state.rawData) return;

    // 计算缩放和偏移，使坐标适配Canvas
    const wh = state.rawData.warehouse;
    const allPoints = [wh, ...(state.rawData.deliveryPoints || [])];
    const xs = allPoints.map(p => p.x);
    const ys = allPoints.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const dataW = maxX - minX || 1;
    const dataH = maxY - minY || 1;
    const pad = 60;
    const scaleX = (W - pad * 2) / dataW;
    const scaleY = (H - pad * 2) / dataH;
    const scale = Math.min(scaleX, scaleY);

    function tx(px) { return pad + (px - minX) * scale; }
    function ty(py) { return pad + (py - minY) * scale; }

    // 配送点（灰色小点）
    if (state.rawData.deliveryPoints) {
      state.rawData.deliveryPoints.forEach(dp => {
        ctx.beginPath();
        ctx.arc(tx(dp.x), ty(dp.y), 4, 0, Math.PI * 2);
        ctx.fillStyle = '#555';
        ctx.fill();
      });
    }

    // 路线
    if (state.result) {
      state.result.routes.forEach((route, ri) => {
        if (route.stops.length === 0) return;
        const color = ROUTE_COLORS[ri % ROUTE_COLORS.length];

        // 路线线段
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.moveTo(tx(wh.x), ty(wh.y));
        route.stops.forEach(stop => {
          ctx.lineTo(tx(stop.x), ty(stop.y));
        });
        // 回程虚线
        const lastStop = route.stops[route.stops.length - 1];
        ctx.stroke();

        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(tx(lastStop.x), ty(lastStop.y));
        ctx.lineTo(tx(wh.x), ty(wh.y));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;

        // 箭头
        for (let i = 0; i < route.stops.length; i++) {
          const from = i === 0 ? wh : route.stops[i - 1];
          const to = route.stops[i];
          drawArrow(tx(from.x), ty(from.y), tx(to.x), ty(to.y), color);
        }

        // 站点圆点
        route.stops.forEach((stop, si) => {
          const sx = tx(stop.x);
          const sy = ty(stop.y);
          const r = 8;

          // 风险背景
          if (stop.risk === 'overdue') {
            ctx.beginPath();
            ctx.arc(sx, sy, r + 4, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255, 90, 90, .25)';
            ctx.fill();
          } else if (stop.risk === 'tight') {
            ctx.beginPath();
            ctx.arc(sx, sy, r + 4, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255, 183, 77, .2)';
            ctx.fill();
          }

          ctx.beginPath();
          ctx.arc(sx, sy, r, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1.5;
          ctx.stroke();

          // 序号
          ctx.fillStyle = '#fff';
          ctx.font = 'bold 9px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(si + 1), sx, sy);
        });
      });
    }

    // 仓库
    const whx = tx(wh.x);
    const why = ty(wh.y);
    ctx.beginPath();
    ctx.arc(whx, why, 12, 0, Math.PI * 2);
    ctx.fillStyle = '#4a9eff';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('W', whx, why);

    // 仓库标签
    ctx.fillStyle = '#4a9eff';
    ctx.font = '11px sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(wh.name, whx, why + 16);

    // 保存映射函数供hover用
    state._tx = tx;
    state._ty = ty;
    state._canvasRect = rect;
  }

  function drawArrow(x1, y1, x2, y2, color) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 20) return;

    const mx = x1 + dx * 0.6;
    const my = y1 + dy * 0.6;
    const angle = Math.atan2(dy, dx);
    const aLen = 6;

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(mx, my);
    ctx.lineTo(mx - aLen * Math.cos(angle - 0.4), my - aLen * Math.sin(angle - 0.4));
    ctx.lineTo(mx - aLen * Math.cos(angle + 0.4), my - aLen * Math.sin(angle + 0.4));
    ctx.closePath();
    ctx.fill();
  }

  // ---- Canvas 鼠标悬停 ----

  canvas.addEventListener('mousemove', e => {
    if (!state.result || !state._tx) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const tooltip = $('mapTooltip');

    let found = null;
    for (const route of state.result.routes) {
      for (const stop of route.stops) {
        const sx = state._tx(stop.x);
        const sy = state._ty(stop.y);
        if (Math.abs(mx - sx) < 12 && Math.abs(my - sy) < 12) {
          found = { stop, route };
          break;
        }
      }
      if (found) break;
    }

    // 检查仓库
    if (!found && state.rawData) {
      const wh = state.rawData.warehouse;
      const wx = state._tx(wh.x);
      const wy = state._ty(wh.y);
      if (Math.abs(mx - wx) < 14 && Math.abs(my - wy) < 14) {
        tooltip.style.display = 'block';
        tooltip.style.left = (e.clientX - rect.left + 16) + 'px';
        tooltip.style.top = (e.clientY - rect.top - 10) + 'px';
        tooltip.textContent = `${wh.name}\n${wh.address}`;
        return;
      }
    }

    if (found) {
      const { stop, route } = found;
      tooltip.style.display = 'block';
      tooltip.style.left = (e.clientX - rect.left + 16) + 'px';
      tooltip.style.top = (e.clientY - rect.top - 10) + 'px';
      tooltip.innerHTML =
        `<b>${stop.dpName}</b> (${stop.orderId})\n` +
        `${stop.description}\n` +
        `重量: ${stop.weight}kg | 时间窗: ${stop.timeWindowStart}-${stop.timeWindowEnd}\n` +
        `到达: ${stop.arriveTime} | 状态: ${riskLabel(stop.risk)}\n` +
        `路线: ${route.vehicleName} - ${route.driverName}\n` +
        `原因: ${stop.reason || ''}`;
    } else {
      tooltip.style.display = 'none';
    }
  });

  canvas.addEventListener('mouseleave', () => {
    $('mapTooltip').style.display = 'none';
  });

  // ---- 拖拽系统 ----

  let dragData = null;

  function clearDropTargets() {
    document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
  }

  function setupDragSource(el, dataFn) {
    el.addEventListener('dragstart', e => {
      dragData = dataFn();
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragData.orderId);
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      clearDropTargets();
      dragData = null;
    });
  }

  function setupDropTarget(el, onDrop) {
    el.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.classList.add('drop-target'); });
    el.addEventListener('dragleave', () => { el.classList.remove('drop-target'); });
    el.addEventListener('drop', e => { e.preventDefault(); el.classList.remove('drop-target'); if (dragData) onDrop(dragData); });
  }

  function bindStopDrag() {
    // 路线站点可拖出
    document.querySelectorAll('.route-stop[draggable]').forEach(el => {
      setupDragSource(el, () => ({
        orderId: el.dataset.orderId,
        fromRouteId: el.dataset.routeId,
        stopIdx: parseInt(el.dataset.stopIdx),
      }));
    });

    // 路线区域接受拖入（来自其他路线或未分配）
    document.querySelectorAll('.route-stops').forEach(el => {
      setupDropTarget(el, drag => {
        const toRouteId = el.dataset.routeId;
        if (drag.source === 'unassigned') {
          handleDropFromUnassigned(drag, toRouteId);
        } else {
          handleDropBetweenRoutes(drag, toRouteId);
        }
      });
    });

    // 未分配区域接受拖入
    setupDropTarget($('unassignedList'), drag => {
      if (drag.source !== 'unassigned') handleDropToUnassigned(drag);
    });
  }

  function bindUnassignedDrag() {
    document.querySelectorAll('.order-item[draggable]').forEach(el => {
      setupDragSource(el, () => ({
        orderId: el.dataset.orderId,
        fromRouteId: null,
        source: 'unassigned',
      }));
    });
  }

  function handleDropBetweenRoutes(drag, toRouteId) {
    if (!state.result || drag.fromRouteId === toRouteId) return;

    pushHistory();

    const fromRoute = state.result.routes.find(r => r.id === drag.fromRouteId);
    const toRoute = state.result.routes.find(r => r.id === toRouteId);
    if (!fromRoute || !toRoute) return;

    const stopIdx = fromRoute.stops.findIndex(s => s.orderId === drag.orderId);
    if (stopIdx < 0) return;
    const stop = fromRoute.stops.splice(stopIdx, 1)[0];
    stop.reason = `用户手动拖拽至 ${toRoute.vehicleName}`;

    // 容量检查（重量+体积）
    const weightOver = toRoute.totalWeight + stop.weight > toRoute.capacityWeight;
    const volOver = toRoute.totalVolume + (stop.volume || 0) > toRoute.capacityVolume;
    if (weightOver || volOver) {
      const msg = weightOver
        ? `载重超限：剩余 ${toRoute.capacityWeight - toRoute.totalWeight}kg，需 ${stop.weight}kg`
        : `体积超限：剩余 ${(toRoute.capacityVolume - toRoute.totalVolume).toFixed(2)}m³，需 ${stop.volume}m³`;
      alert(`${toRoute.vehicleName} ${msg}`);
      fromRoute.stops.splice(stopIdx, 0, stop);
      state.history.pop();
      return;
    }

    // 立即更新本地指标，避免连续拖拽时的竞态
    fromRoute.totalWeight -= stop.weight;
    fromRoute.totalVolume -= (stop.volume || 0);
    toRoute.totalWeight += stop.weight;
    toRoute.totalVolume += (stop.volume || 0);

    toRoute.stops.push(stop);
    recalcRouteViaWorker(fromRoute);
    recalcRouteViaWorker(toRoute);
    renderAll();
  }

  function handleDropToUnassigned(drag) {
    if (!state.result) return;

    pushHistory();

    const fromRoute = state.result.routes.find(r => r.id === drag.fromRouteId);
    if (!fromRoute) return;

    const stopIdx = fromRoute.stops.findIndex(s => s.orderId === drag.orderId);
    if (stopIdx < 0) return;
    const stop = fromRoute.stops.splice(stopIdx, 1)[0];

    fromRoute.totalWeight -= stop.weight;
    fromRoute.totalVolume -= (stop.volume || 0);

    state.result.unassigned.push({ ...stop, status: 'unassigned', problems: ['用户手动移除出路线'] });
    state.result.stats.assignedCount--;
    state.result.stats.unassignedCount++;

    recalcRouteViaWorker(fromRoute);
    renderAll();
  }

  function handleDropFromUnassigned(drag, toRouteId) {
    if (!state.result) return;

    pushHistory();

    const toRoute = state.result.routes.find(r => r.id === toRouteId);
    if (!toRoute) return;

    const uIdx = state.result.unassigned.findIndex(o => o.id === drag.orderId);
    if (uIdx < 0) return;
    const order = state.result.unassigned.splice(uIdx, 1)[0];

    const weightOver = toRoute.totalWeight + order.weight > toRoute.capacityWeight;
    const volOver = toRoute.totalVolume + (order.volume || 0) > toRoute.capacityVolume;
    if (weightOver || volOver) {
      const msg = weightOver
        ? `载重超限：剩余 ${toRoute.capacityWeight - toRoute.totalWeight}kg，需 ${order.weight}kg`
        : `体积超限：剩余 ${(toRoute.capacityVolume - toRoute.totalVolume).toFixed(2)}m³，需 ${order.volume}m³`;
      alert(`${toRoute.vehicleName} ${msg}`);
      state.result.unassigned.splice(uIdx, 0, order);
      state.history.pop();
      return;
    }

    toRoute.totalWeight += order.weight;
    toRoute.totalVolume += (order.volume || 0);

    toRoute.stops.push({
      orderId: order.id, deliveryPointId: order.deliveryPointId,
      dpName: order.dpName, x: order.x, y: order.y,
      weight: order.weight, volume: order.volume,
      priority: order.priority, description: order.description,
      timeWindowStart: order.timeWindowStart, timeWindowEnd: order.timeWindowEnd,
      arriveTime: '--:--', serviceStart: '--:--', serviceEnd: '--:--',
      waitMin: 0, breakBefore: false, risk: 'ok',
      reason: `用户手动分配至 ${toRoute.vehicleName}`,
    });

    state.result.stats.assignedCount++;
    state.result.stats.unassignedCount--;

    recalcRouteViaWorker(toRoute);
    renderAll();
  }

  function recalcRouteViaWorker(route) {
    worker.postMessage({
      type: 'recalc-route',
      payload: {
        route: JSON.parse(JSON.stringify(route)),
        warehouse: state.rawData.warehouse,
      },
    });
  }

  // ---- 回退 ----

  function pushHistory() {
    state.history.push(JSON.stringify(state.result));
    if (state.history.length > 20) state.history.shift();
    $('btnUndo').disabled = false;
  }

  $('btnUndo').addEventListener('click', () => {
    if (state.history.length === 0) return;
    const snap = state.history.pop();
    state.result = JSON.parse(snap);
    $('btnUndo').disabled = state.history.length === 0;
    renderAll();
  });

  // ---- 导出 ----

  $('btnExport').addEventListener('click', () => {
    if (!state.result) return;
    const exportData = {
      exportTime: new Date().toISOString(),
      stats: state.result.stats,
      routes: state.result.routes.map(r => ({
        id: r.id,
        driver: r.driverName,
        vehicle: r.vehicleName,
        stops: r.stops.map(s => ({
          orderId: s.orderId,
          deliveryPoint: s.dpName,
          arriveTime: s.arriveTime,
          timeWindow: s.timeWindowStart + '-' + s.timeWindowEnd,
          weight: s.weight,
          risk: s.risk,
          reason: s.reason,
        })),
        totalWeight: r.totalWeight,
        totalDistance: r.totalDistance,
        loadRateWeight: r.loadRateWeight,
        warnings: r.warnings,
      })),
      unassigned: state.result.unassigned,
      invalid: state.result.invalid,
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dispatch-plan-${new Date().toISOString().slice(0, 16).replace(/:/g, '')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // ---- 保存/恢复 (localStorage) ----

  $('btnSave').addEventListener('click', () => {
    if (!state.result || !state.rawData) return;
    const saveData = {
      rawData: state.rawData,
      result: state.result,
      savedAt: new Date().toISOString(),
    };
    try {
      localStorage.setItem('dispatch-last-plan', JSON.stringify(saveData));
      alert('已保存到浏览器');
    } catch (err) {
      alert('保存失败: ' + err.message);
    }
  });

  $('btnRestore').addEventListener('click', () => {
    try {
      const saved = localStorage.getItem('dispatch-last-plan');
      if (!saved) {
        alert('没有保存的规划');
        return;
      }
      const data = JSON.parse(saved);
      state.rawData = data.rawData;
      state.result = data.result;
      state.history = [];
      $('btnPlan').disabled = false;
      enableButtons();
      renderDataOverview();
      renderAll();
    } catch (err) {
      alert('恢复失败: ' + err.message);
    }
  });

  // ---- 窗口缩放 ----

  window.addEventListener('resize', () => {
    drawCanvas();
  });

  // ---- 初始化 ----

  drawCanvas();
})();
