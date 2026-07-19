(function () {
  'use strict';

  var POLL_MS = 2000;
  var STALE_MS = 6000;
  var graph = document.getElementById('graph');
  var tokenMeta = document.querySelector('meta[name="swarm-token"]');
  var hashToken = new URLSearchParams(window.location.hash.slice(1)).get('token');
  var token = hashToken || (tokenMeta ? tokenMeta.getAttribute('content') : '');
  var state = {
    board: null,
    cy: null,
    topologyHash: null,
    firstRender: true,
    selectedId: null,
    inspectedEvent: null,
    lastPollAt: 0,
    onlyNeeds: true,
    view: 'graph',
    taskSortKey: 'urgency',
    taskSortDir: 'asc',
    taskFilter: '',
    charts: { debris: null, tasks: null, timeline: null }
  };

  if (hashToken && window.history && window.history.replaceState) {
    window.history.replaceState(null, document.title, window.location.pathname);
  }

  function element(id) {
    return document.getElementById(id);
  }

  function setText(target, value) {
    if (target) target.textContent = String(value);
  }

  function clear(target) {
    while (target && target.firstChild) target.removeChild(target.firstChild);
  }

  function ageLabel(value, reference) {
    if (!value) return 'not recorded';
    var timestamp = new Date(value).getTime();
    var referenceTime = new Date(reference).getTime();
    if (!Number.isFinite(timestamp) || !Number.isFinite(referenceTime)) return 'unknown';
    return Math.max(0, Math.floor((referenceTime - timestamp) / 60000)) + 'm ago';
  }

  function timeLabel(value) {
    var timestamp = new Date(value);
    if (!Number.isFinite(timestamp.getTime())) return String(value || 'unknown');
    return timestamp.toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }

  function safeDetail(value) {
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch (_error) {
      return String(value);
    }
  }

  function isDarkMode() {
    return Boolean(window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function palette() {
    if (isDarkMode()) {
      return {
        ink: '#e2e8f0', muted: '#95a3b1', line: '#43515e', selected: '#61b7e4',
        panel: '#17212b', claudeBg: '#392c63', claudeLine: '#9b83ff',
        codexBg: '#173f55', codexLine: '#52b7e8', grokBg: '#55272b',
        grokLine: '#e06a71', geminiBg: '#183f2d', geminiLine: '#58b886',
        a2aBg: '#503818', a2aLine: '#d69b38', headlessBg: '#333840',
        headlessLine: '#8e99a5', unknownBg: '#27323d', unknownLine: '#7f8d9a',
        activeBg: '#193d25', activeLine: '#4dc468', awaitingBg: '#4b3817',
        awaitingLine: '#e5a62c', staleBg: '#54242a', staleLine: '#f0646d',
        openBg: '#2b333c', openLine: '#818d99', debrisBg: '#4a321c',
        debrisLine: '#df8d32'
      };
    }
    return {
      ink: '#172033', muted: '#687481', line: '#aeb7bf', selected: '#1677a8',
      panel: '#ffffff', claudeBg: '#d9ccff', claudeLine: '#6d4aff',
      codexBg: '#c7e9ff', codexLine: '#1677a8', grokBg: '#ffd0d0',
      grokLine: '#bb3e3e', geminiBg: '#c9f2dc', geminiLine: '#27845a',
      a2aBg: '#ffe2ad', a2aLine: '#a86600', headlessBg: '#e4e4e7',
      headlessLine: '#71717a', unknownBg: '#f1f5f9', unknownLine: '#64748b',
      activeBg: '#c8f3d1', activeLine: '#238636', awaitingBg: '#ffe7a3',
      awaitingLine: '#b77900', staleBg: '#ffd0d0', staleLine: '#d1242f',
      openBg: '#e5e7eb', openLine: '#6b7280', debrisBg: '#ffd8a8',
      debrisLine: '#d97706'
    };
  }

  function cyStyles() {
    var color = palette();
    var hostStyles = [
      ['claude', color.claudeBg, color.claudeLine],
      ['codex', color.codexBg, color.codexLine],
      ['grok', color.grokBg, color.grokLine],
      ['gemini', color.geminiBg, color.geminiLine],
      ['a2a', color.a2aBg, color.a2aLine],
      ['headless', color.headlessBg, color.headlessLine],
      ['unknown', color.unknownBg, color.unknownLine]
    ].map(function (entry) {
      return {
        selector: 'node.host-' + entry[0],
        style: { 'background-color': entry[1], 'border-color': entry[2] }
      };
    });
    return [
      {
        selector: 'node',
        style: {
          width: 'label', height: 'label', padding: '14px', color: color.ink,
          'font-family': 'Avenir Next, Helvetica Neue, sans-serif',
          'font-size': '12px', 'font-weight': 600, label: 'data(label)',
          'text-wrap': 'wrap', 'text-max-width': '170px', 'text-valign': 'center',
          'text-halign': 'center', 'border-width': 2, 'border-color': color.line,
          'background-color': color.unknownBg, 'overlay-opacity': 0
        }
      },
      { selector: 'node.agent', style: { shape: 'round-rectangle', 'min-width': '112px' } },
      { selector: 'node.task', style: { shape: 'rectangle', 'min-width': '126px' } }
    ].concat(hostStyles).concat([
      { selector: 'node.st-active', style: { 'background-color': color.activeBg, 'border-color': color.activeLine } },
      { selector: 'node.st-awaiting_review', style: { 'background-color': color.awaitingBg, 'border-color': color.awaitingLine } },
      { selector: 'node.st-open', style: { 'background-color': color.openBg, 'border-color': color.openLine } },
      { selector: 'node.st-done', style: { 'background-color': color.openBg, 'border-color': color.openLine, opacity: 0.55 } },
      { selector: 'node.stale', style: { 'background-color': color.staleBg, 'border-color': color.staleLine, 'border-width': 4 } },
      { selector: 'node.debris', style: { shape: 'round-tag', 'background-color': color.openBg, 'border-color': color.openLine } },
      { selector: 'node.debris-warn', style: { 'background-color': color.debrisBg, 'border-color': color.debrisLine } },
      { selector: 'node.dimmed', style: { opacity: 0.16 } },
      {
        selector: 'edge',
        style: {
          width: 1.7, 'line-color': color.line, 'target-arrow-color': color.line,
          'target-arrow-shape': 'triangle', 'arrow-scale': 0.85, 'curve-style': 'bezier',
          opacity: 0.72, 'overlay-opacity': 0
        }
      },
      { selector: 'edge.solid', style: { 'line-style': 'solid' } },
      { selector: 'edge.dashed', style: { 'line-style': 'dashed', 'line-dash-pattern': [8, 5] } },
      { selector: 'edge.dotted', style: { 'line-style': 'dotted', 'line-dash-pattern': [2, 5] } },
      { selector: 'node.highlight', style: { 'border-width': 5, 'border-color': color.selected } },
      { selector: 'edge.highlight', style: { width: 4, opacity: 1, 'line-color': color.selected, 'target-arrow-color': color.selected } },
      { selector: 'node:selected', style: { 'border-width': 5, 'border-color': color.selected } }
    ]);
  }

  function chartTheme() {
    var color = palette();
    return {
      color: ['#3b82f6', '#22c55e', '#8b5cf6', '#f59e0b', '#14b8a6', '#ef4444', '#94a3b8'],
      backgroundColor: 'transparent',
      textStyle: { color: color.ink, fontFamily: 'Avenir Next, Helvetica Neue, sans-serif' },
      title: { textStyle: { color: color.muted, fontSize: 10, fontWeight: 500 } },
      categoryAxis: {
        axisLine: { lineStyle: { color: color.line } },
        axisTick: { lineStyle: { color: color.line } },
        axisLabel: { color: color.muted, fontSize: 9 },
        splitLine: { lineStyle: { color: color.line } }
      },
      valueAxis: {
        axisLine: { lineStyle: { color: color.line } },
        axisTick: { lineStyle: { color: color.line } },
        axisLabel: { color: color.muted, fontSize: 9 },
        splitLine: { lineStyle: { color: color.line, opacity: 0.35 } }
      },
      timeAxis: {
        axisLine: { lineStyle: { color: color.line } },
        axisTick: { lineStyle: { color: color.line } },
        axisLabel: { color: color.muted, fontSize: 9 },
        splitLine: { lineStyle: { color: color.line, opacity: 0.25 } }
      }
    };
  }

  function createGraph() {
    if (!window.cytoscape || !window.boardElements) {
      setText(graph, 'Board graph assets are unavailable. Reinstall or rebuild swarm.');
      return null;
    }
    var cy = window.cytoscape({
      container: graph,
      elements: [],
      style: cyStyles(),
      boxSelectionEnabled: false,
      wheelSensitivity: 0.22,
      minZoom: 0.2,
      maxZoom: 2.5
    });
    cy.on('tap', 'node', function (event) {
      selectNode(event.target.id());
    });
    cy.on('tap', function (event) {
      if (event.target === cy) selectNode(null);
    });
    return cy;
  }

  function chartFor(key, id) {
    if (!window.echarts) return null;
    if (!state.charts[key]) {
      var target = element(id);
      if (!target) return null;
      state.charts[key] = window.echarts.init(target, chartTheme());
      if (key === 'timeline') {
        state.charts[key].on('click', function (parameters) {
          if (parameters && parameters.data && parameters.data.event) {
            state.inspectedEvent = parameters.data.event;
            inspectSelection(state.selectedId);
          }
        });
      }
    }
    return state.charts[key];
  }

  function disposeCharts() {
    Object.keys(state.charts).forEach(function (key) {
      if (state.charts[key]) state.charts[key].dispose();
      state.charts[key] = null;
    });
  }

  function emptyChartOption(message) {
    return {
      animation: false,
      title: { text: message, left: 'center', top: 'middle' },
      xAxis: { show: false },
      yAxis: { show: false },
      series: []
    };
  }

  function taskStateColor(stateName) {
    var colors = {
      active: '#22c55e', awaiting_review: '#f59e0b', open: '#94a3b8', done: '#14b8a6'
    };
    return colors[stateName] || '#3b82f6';
  }

  function renderDashboard(board) {
    var unackedTotal = board.agents.reduce(function (sum, agent) {
      return sum + Number(agent.unackedCount || 0);
    }, 0);
    var maxAges = board.agents.map(function (agent) {
      return agent.unackedMaxAgeMin;
    }).filter(function (value) {
      return typeof value === 'number' && Number.isFinite(value);
    });
    var unackedMaxAge = maxAges.length > 0 ? Math.max.apply(Math, maxAges) : null;
    setText(element('unacked-total'), unackedTotal);
    setText(element('unacked-max-age'), unackedMaxAge === null ? '—' : unackedMaxAge + 'm');

    var counts = Object.create(null);
    board.tasks.forEach(function (task) {
      var taskState = String(task.state || 'unknown');
      counts[taskState] = (counts[taskState] || 0) + 1;
    });
    var states = Object.keys(counts).sort();
    var taskChart = chartFor('tasks', 'task-state-chart');
    if (taskChart) {
      if (states.length === 0) {
        taskChart.setOption(emptyChartOption('no tasks'), true);
      } else {
        taskChart.setOption({
          animation: false,
          tooltip: { show: false },
          grid: { left: 4, right: 12, top: 2, bottom: 2, containLabel: true },
          xAxis: { type: 'value', minInterval: 1, axisLabel: { show: false }, splitLine: { show: false } },
          yAxis: { type: 'category', inverse: true, data: states, axisTick: { show: false } },
          series: [{
            type: 'bar',
            barMaxWidth: 9,
            data: states.map(function (taskState) {
              return { value: counts[taskState], itemStyle: { color: taskStateColor(taskState) } };
            }),
            label: { show: true, position: 'right', fontSize: 9 }
          }]
        }, true);
      }
    }

    var debrisChart = chartFor('debris', 'debris-trend-chart');
    if (!debrisChart) return;
    if (!Object.prototype.hasOwnProperty.call(board, 'debrisTrend')) {
      debrisChart.setOption(emptyChartOption('not available'), true);
      return;
    }
    if (!Array.isArray(board.debrisTrend) || board.debrisTrend.length === 0) {
      debrisChart.setOption(emptyChartOption('no snapshots'), true);
      return;
    }
    var counterSeries = [
      ['detachedHeads', '#3b82f6'],
      ['orphanedWorktrees', '#8b5cf6'],
      ['unpushedCommits', '#ef4444'],
      ['goneUpstreamBranches', '#f59e0b'],
      ['tempStrays', '#14b8a6'],
      ['junkDirs', '#94a3b8']
    ];
    debrisChart.setOption({
      animation: false,
      tooltip: { show: false },
      grid: { left: 4, right: 4, top: 5, bottom: 14, containLabel: true },
      xAxis: { type: 'time', axisLabel: { show: false }, axisTick: { show: false } },
      yAxis: { type: 'value', minInterval: 1, axisLabel: { fontSize: 8 }, splitNumber: 2 },
      series: counterSeries.map(function (entry) {
        return {
          name: entry[0],
          type: 'line',
          showSymbol: false,
          symbol: 'none',
          lineStyle: { width: 1.25, color: entry[1] },
          data: board.debrisTrend.map(function (point) {
            return [point.tickAt, Number(point.counters[entry[0]] || 0)];
          })
        };
      })
    }, true);
  }

  function renderHeader(board) {
    setText(element('swarm-name'), board.swarm.name);
    setText(element('agent-count'), board.agents.length);
    setText(element('task-count'), board.tasks.length);
    setText(element('updated-at'), timeLabel(board.generatedAt));
    document.title = board.swarm.name + ' · Swarm board';
  }

  function triageItems(board) {
    var items = board.needsYou.slice();
    if (state.onlyNeeds) return items;
    var taskRefs = Object.create(null);
    items.forEach(function (item) {
      taskRefs[String(item.refId)] = true;
    });
    board.tasks.forEach(function (task) {
      if (taskRefs[String(task.id)]) return;
      items.push({
        kind: task.state,
        label: 'task ' + task.id + ' — ' + task.title + ' · ' + (task.owner || 'unowned'),
        refId: task.id
      });
    });
    return items;
  }

  function renderNeeds(board) {
    var list = element('needs-list');
    var items = triageItems(board);
    clear(list);
    setText(element('triage-title'), state.onlyNeeds ? 'Needs you' : 'Fleet triage');
    setText(element('needs-count'), items.length);
    if (items.length === 0) {
      var quiet = document.createElement('li');
      quiet.className = 'quiet-item';
      quiet.textContent = state.onlyNeeds ? 'Nothing needs you.' : 'No fleet items.';
      list.appendChild(quiet);
      return;
    }
    items.forEach(function (need) {
      var item = document.createElement('li');
      var kind = document.createElement('span');
      var label = document.createElement('span');
      item.className = 'needs-item';
      kind.className = 'kind-chip';
      kind.textContent = need.kind;
      label.textContent = need.label;
      item.appendChild(kind);
      item.appendChild(label);
      list.appendChild(item);
    });
  }

  function taskCell(row, text, className) {
    var cell = document.createElement('td');
    if (className) cell.className = className;
    cell.textContent = text;
    row.appendChild(cell);
    return cell;
  }

  function updateTaskSortHeaders() {
    var headers = document.querySelectorAll('.task-table th[data-sort-key]');
    Array.prototype.forEach.call(headers, function (header) {
      var key = header.getAttribute('data-sort-key');
      var selected = state.taskSortKey === key;
      var indicator = header.querySelector('.sort-indicator');
      header.setAttribute('aria-sort', selected
        ? (state.taskSortDir === 'asc' ? 'ascending' : 'descending')
        : 'none');
      setText(indicator, selected ? (state.taskSortDir === 'asc' ? '↑' : '↓') : '↕');
    });
  }

  function emptyTaskRow(body, message) {
    var row = document.createElement('tr');
    var cell = document.createElement('td');
    cell.className = 'task-empty-cell';
    cell.colSpan = 6;
    cell.textContent = message;
    row.appendChild(cell);
    body.appendChild(row);
  }

  function renderTasks(board) {
    var body = element('tasks-body');
    if (!body) return;
    clear(body);
    updateTaskSortHeaders();
    if (!window.taskRows) {
      setText(element('filtered-task-count'), '0 tasks');
      emptyTaskRow(body, 'Task table assets are unavailable.');
      return;
    }
    // The table is a full task list — it always shows every task (narrowed only
    // by its own text filter). The "only what needs me" toggle is a graph/triage
    // affordance and must NOT silently hide most of the list.
    var rows = window.taskRows(board, {
      sortKey: state.taskSortKey,
      sortDir: state.taskSortDir,
      filter: state.taskFilter,
      onlyNeeds: false
    });
    setText(element('filtered-task-count'), rows.length + (rows.length === 1 ? ' task' : ' tasks'));
    if (rows.length === 0) {
      emptyTaskRow(body, board.tasks.length === 0
        ? 'No tasks recorded.'
        : 'No tasks match the current filters.');
      return;
    }
    rows.forEach(function (task) {
      var row = document.createElement('tr');
      var stateCell;
      var statePill;
      var branchCell;
      var branchWrap;
      var branchName;
      var gitIndicator;
      var nextAction;
      row.className = 'task-row';
      row.tabIndex = 0;
      row.classList.toggle('is-selected', state.selectedId === task.id);
      row.setAttribute('aria-selected', state.selectedId === task.id ? 'true' : 'false');
      taskCell(row, task.slug, 'task-slug');

      stateCell = document.createElement('td');
      statePill = document.createElement('span');
      statePill.className = 'state-pill ' + task.stateClass + (task.stale ? ' is-stale' : '');
      statePill.textContent = task.stateLabel;
      if (task.stale) {
        var stale = document.createElement('span');
        stale.className = 'stale-marker';
        stale.textContent = 'STALE';
        statePill.appendChild(stale);
      }
      stateCell.appendChild(statePill);
      row.appendChild(stateCell);

      taskCell(row, task.owner, 'task-owner');
      taskCell(row, task.checkpointLabel, 'numeric-cell');

      branchCell = document.createElement('td');
      branchWrap = document.createElement('div');
      branchName = document.createElement('span');
      gitIndicator = document.createElement('span');
      branchWrap.className = 'branch-cell';
      branchName.className = 'branch-name';
      gitIndicator.className = 'git-indicator';
      branchName.textContent = task.branch;
      gitIndicator.textContent = task.gitLabel;
      branchWrap.appendChild(branchName);
      branchWrap.appendChild(gitIndicator);
      branchCell.appendChild(branchWrap);
      row.appendChild(branchCell);

      nextAction = taskCell(row, task.nextActionShort, 'next-action');
      nextAction.setAttribute('title', task.nextActionFull);
      function chooseTask() {
        selectNode(task.id);
      }
      row.addEventListener('click', chooseTask);
      row.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          chooseTask();
        }
      });
      body.appendChild(row);
    });
  }

  function setView(view) {
    var nextView = view === 'tasks' ? 'tasks' : 'graph';
    var graphTab = element('graph-tab');
    var tasksTab = element('tasks-tab');
    var tasksView = element('tasks-view');
    var graphKey = element('graph-key');
    state.view = nextView;
    graph.hidden = nextView !== 'graph';
    if (tasksView) tasksView.hidden = nextView !== 'tasks';
    if (graphKey) graphKey.hidden = nextView !== 'graph';
    if (graphTab) {
      graphTab.classList.toggle('is-active', nextView === 'graph');
      graphTab.setAttribute('aria-selected', nextView === 'graph' ? 'true' : 'false');
    }
    if (tasksTab) {
      tasksTab.classList.toggle('is-active', nextView === 'tasks');
      tasksTab.setAttribute('aria-selected', nextView === 'tasks' ? 'true' : 'false');
    }
    if (nextView === 'tasks' && state.board) renderTasks(state.board);
    if (nextView === 'graph' && state.cy) {
      window.requestAnimationFrame(function () { state.cy.resize(); });
    }
  }

  function detailRow(list, key, value) {
    var row = document.createElement('li');
    var term = document.createElement('span');
    var detail = document.createElement('span');
    row.className = 'detail-row';
    term.className = 'detail-key';
    detail.className = 'detail-value';
    term.textContent = key;
    detail.textContent = value === null || value === undefined || value === ''
      ? 'not recorded'
      : String(value);
    row.appendChild(term);
    row.appendChild(detail);
    list.appendChild(row);
  }

  function heading(body, label) {
    var title = document.createElement('h3');
    title.className = 'subheading';
    title.textContent = label;
    body.appendChild(title);
  }

  function inspectorList(body) {
    var list = document.createElement('ul');
    list.className = 'detail-list';
    body.appendChild(list);
    return list;
  }

  function showFocusStatus(target, message, failed) {
    target.classList.toggle('is-error', failed);
    target.textContent = message;
    window.setTimeout(function () {
      if (target.isConnected && target.textContent === message) target.textContent = '';
    }, 4500);
  }

  function requestFocus(agentName, button, status) {
    button.disabled = true;
    showFocusStatus(status, 'Focusing terminal…', false);
    fetch('/api/focus-agent', {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'X-Swarm-Token': token
      },
      body: JSON.stringify({ agent: agentName })
    }).then(function (response) {
      return response.json().then(function (payload) {
        return { response: response, payload: payload };
      });
    }).then(function (result) {
      var message = result.payload.message || result.payload.error ||
        (result.response.ok ? 'Focused terminal.' : 'Focus request failed.');
      showFocusStatus(status, message, !result.payload.ok);
    }).catch(function () {
      showFocusStatus(status, 'Focus request failed; confirm the board server is still running.', true);
    }).then(function () {
      if (button.isConnected) button.disabled = false;
    });
  }

  function inspectAgent(agent, board) {
    var body = element('inspector-body');
    var list = inspectorList(body);
    setText(element('inspector-title'), agent.name);
    detailRow(list, 'Host', agent.host);
    detailRow(list, 'Agent type', agent.agentType);
    detailRow(list, 'Heartbeat', ageLabel(agent.lastHeartbeat, board.generatedAt));
    detailRow(list, 'Current task', agent.currentTaskId || 'idle');
    detailRow(list, 'Progress evidence', ageLabel(agent.progressEvidenceAt, board.generatedAt));
    detailRow(list, 'Unacked', agent.unackedCount +
      (agent.unackedMaxAgeMin === null ? '' : ' · oldest ' + agent.unackedMaxAgeMin + 'm'));
    detailRow(list, 'Surface known', agent.surfaceKnown ? 'yes' : 'no');

    var button = document.createElement('button');
    var status = document.createElement('p');
    button.className = 'action-button';
    button.type = 'button';
    button.textContent = 'Focus terminal';
    status.className = 'transient-status';
    status.setAttribute('role', 'status');
    if (agent.agentType !== 'cmux' || !agent.surfaceKnown) {
      button.disabled = true;
      button.title = 'This agent has no registered cmux terminal.';
    } else {
      button.addEventListener('click', function () {
        requestFocus(agent.name, button, status);
      });
    }
    body.appendChild(button);
    body.appendChild(status);
  }

  function gitFacts(task) {
    if (!task.git) return 'not available';
    return (task.git.dirty ? 'dirty' : 'tracked clean') + ' · ' + task.git.untracked +
      ' untracked · ' + task.git.unpushed + ' unpushed';
  }

  function renderTaskEvents(body, task, board) {
    heading(body, 'Recent task events');
    var list = document.createElement('ul');
    list.className = 'event-list';
    var events = board.timeline.filter(function (event) {
      return event.taskId === task.id;
    }).slice(-12).reverse();
    if (events.length === 0) {
      var quiet = document.createElement('li');
      quiet.className = 'quiet-item';
      quiet.textContent = 'No recent events.';
      list.appendChild(quiet);
    }
    events.forEach(function (event) {
      var item = document.createElement('li');
      var meta = document.createElement('div');
      var summary = document.createElement('div');
      item.className = 'event-item';
      meta.className = 'event-meta';
      summary.className = 'event-summary';
      meta.textContent = event.kind + ' · epoch ' + event.epoch + ' · ' +
        (event.actor || 'system') + ' · ' + timeLabel(event.at);
      summary.textContent = event.summary;
      item.appendChild(meta);
      item.appendChild(summary);
      list.appendChild(item);
    });
    body.appendChild(list);
  }

  function inspectTask(task, board) {
    var body = element('inspector-body');
    var list = inspectorList(body);
    setText(element('inspector-title'), task.id);
    detailRow(list, 'Title', task.title);
    detailRow(list, 'State', task.state + (task.stale ? ' · stale' : ''));
    detailRow(list, 'Owner / epoch', (task.owner || 'unowned') + ' / ' + task.leaseEpoch);
    detailRow(list, 'Checkpoint', task.checkpoint
      ? task.checkpoint.ageMin + 'm ago · #' + task.checkpoint.seq
      : 'none');
    detailRow(list, 'Next action', task.checkpoint ? task.checkpoint.nextAction : 'not recorded');
    detailRow(list, 'Branch', task.branch || 'not recorded');
    detailRow(list, 'Git', gitFacts(task));
    detailRow(list, 'Repository', task.repoPath || 'not recorded');
    detailRow(list, 'Worktree', task.worktreePath || 'not recorded');
    renderTaskEvents(body, task, board);
  }

  function inspectDebris(board) {
    var body = element('inspector-body');
    var list = inspectorList(body);
    var counters = board.debris.counters;
    setText(element('inspector-title'), 'Debris');
    detailRow(list, 'Janitor tick', board.debris.tickAgeMin === null
      ? 'never'
      : board.debris.tickAgeMin + 'm ago');
    Object.keys(counters).forEach(function (key) {
      detailRow(list, key, counters[key]);
    });
    heading(body, 'Findings');
    var findings = document.createElement('ul');
    findings.className = 'finding-list';
    if (board.debris.findings.length === 0) {
      var quiet = document.createElement('li');
      quiet.className = 'quiet-item';
      quiet.textContent = 'No debris findings.';
      findings.appendChild(quiet);
    }
    board.debris.findings.forEach(function (finding) {
      var item = document.createElement('li');
      var meta = document.createElement('div');
      var findingPath = document.createElement('div');
      var detail = document.createElement('div');
      item.className = 'finding-item';
      meta.className = 'finding-meta';
      findingPath.className = 'event-summary';
      detail.className = 'finding-detail';
      meta.textContent = finding.kind + ' · ' + finding.state;
      findingPath.textContent = finding.path;
      detail.textContent = safeDetail(finding.detail);
      item.appendChild(meta);
      item.appendChild(findingPath);
      item.appendChild(detail);
      findings.appendChild(item);
    });
    body.appendChild(findings);
  }

  function inspectEvent(event) {
    var body = element('inspector-body');
    var list = inspectorList(body);
    setText(element('inspector-title'), 'Task event');
    detailRow(list, 'Task', event.taskId);
    detailRow(list, 'Kind', event.kind);
    detailRow(list, 'Epoch', event.epoch);
    detailRow(list, 'Actor', event.actor || 'system');
    detailRow(list, 'At', timeLabel(event.at));
    detailRow(list, 'Summary', event.summary);
  }

  function inspectSelection(nodeId) {
    var board = state.board;
    var body = element('inspector-body');
    clear(body);
    if (state.inspectedEvent) {
      inspectEvent(state.inspectedEvent);
      return;
    }
    if (!nodeId || !board) {
      setText(element('inspector-title'), 'Select a node');
      var quiet = document.createElement('p');
      quiet.className = 'quiet-copy';
      quiet.textContent = 'Choose an agent, task, or debris node without leaving the fleet map.';
      body.appendChild(quiet);
      return;
    }
    var node = state.cy.getElementById(nodeId);
    var kind = node.data('kind');
    var refId = node.data('refId');
    if (kind === 'agent') {
      var agent = board.agents.find(function (candidate) { return candidate.name === refId; });
      if (agent) inspectAgent(agent, board);
    } else if (kind === 'task') {
      var task = board.tasks.find(function (candidate) { return candidate.id === refId; });
      if (task) inspectTask(task, board);
    } else if (kind === 'debris') {
      inspectDebris(board);
    }
  }

  function selectedTaskId() {
    if (!state.cy || !state.selectedId) return null;
    var selected = state.cy.getElementById(state.selectedId);
    if (!selected || selected.empty() || selected.data('kind') !== 'task') return null;
    return selected.data('taskId');
  }

  function applySelection() {
    if (!state.cy) return;
    state.cy.elements().removeClass('highlight');
    if (!state.selectedId) return;
    var node = state.cy.getElementById(state.selectedId);
    if (!node || node.empty()) {
      state.selectedId = null;
      return;
    }
    if (!node.selected()) node.select();
    if (node.data('kind') !== 'task' || !state.board) return;
    var taskId = node.data('taskId');
    var task = state.board.tasks.find(function (candidate) { return candidate.id === taskId; });
    if (!task) return;
    state.cy.nodes().filter(function (candidate) {
      return candidate.data('kind') === 'agent' && task.owner &&
        String(candidate.data('name')).toLowerCase() === String(task.owner).toLowerCase();
    }).addClass('highlight');
    state.cy.edges().filter(function (edge) {
      return edge.data('taskId') === taskId &&
        (edge.data('kind') === 'handoff' || edge.data('kind') === 'claim');
    }).addClass('highlight');
  }

  function applyNeedsFilter() {
    if (!state.cy) return;
    state.cy.nodes().removeClass('dimmed');
    if (!state.onlyNeeds || !state.board) return;
    var referenced = window.needsYouNodeIds
      ? window.needsYouNodeIds(state.board)
      : [];
    var keep = Object.create(null);
    referenced.forEach(function (nodeId) { keep[nodeId] = true; });
    state.cy.nodes().filter(function (node) {
      return !keep[node.id()];
    }).addClass('dimmed');
  }

  function selectNode(nodeId) {
    if (!state.cy) return;
    state.cy.nodes().unselect();
    state.selectedId = nodeId;
    state.inspectedEvent = null;
    applySelection();
    applyNeedsFilter();
    inspectSelection(state.selectedId);
    renderTimeline();
    if (state.board) renderTasks(state.board);
  }

  function updateGraph(board) {
    if (!state.cy) return;
    var mapped = window.boardElements(board);
    if (mapped.topologyHash !== state.topologyHash) {
      var selected = state.selectedId;
      state.cy.batch(function () {
        state.cy.elements().remove();
        state.cy.add(mapped.elements);
      });
      state.topologyHash = mapped.topologyHash;
      state.selectedId = selected && !state.cy.getElementById(selected).empty() ? selected : null;
      state.cy.layout({
        name: 'dagre',
        rankDir: 'LR',
        nodeSep: 46,
        rankSep: 104,
        edgeSep: 22,
        padding: 54,
        fit: state.firstRender,
        animate: false
      }).run();
      state.firstRender = false;
    } else {
      state.cy.batch(function () {
        mapped.elements.forEach(function (next) {
          var current = state.cy.getElementById(next.data.id);
          current.data(next.data);
          current.classes(next.classes);
        });
      });
    }
    applySelection();
    applyNeedsFilter();
    inspectSelection(state.selectedId);
  }

  function renderTimeline() {
    if (!state.board || !window.timelineRecords) return;
    var taskId = selectedTaskId();
    var mapped = window.timelineRecords(state.board, taskId);
    var chart = chartFor('timeline', 'timeline-chart');
    setText(element('timeline-filter'), taskId ? 'Filtered to ' + taskId : 'All recent tasks');
    if (!chart) return;
    if (mapped.records.length === 0) {
      chart.setOption(emptyChartOption(taskId ? 'no events for task' : 'no recent events'), true);
      return;
    }
    chart.setOption({
      animation: false,
      tooltip: { show: false },
      grid: { left: 12, right: 18, top: 8, bottom: 28, containLabel: true },
      xAxis: {
        type: 'time',
        axisLabel: { hideOverlap: true, fontSize: 9 },
        splitLine: { show: true }
      },
      yAxis: {
        type: 'category',
        data: mapped.lanes,
        axisTick: { show: false },
        axisLabel: { width: 120, overflow: 'truncate', fontSize: 9 }
      },
      series: [{
        type: 'scatter',
        symbolSize: 10,
        data: mapped.records.map(function (record) {
          return {
            value: record.value,
            event: record.event,
            itemStyle: { color: record.color, borderColor: palette().panel, borderWidth: 1 }
          };
        })
      }]
    }, true);
  }

  function refreshFreshness() {
    var age = state.lastPollAt ? Date.now() - state.lastPollAt : Infinity;
    var stale = age > STALE_MS;
    var dot = element('freshness-dot');
    if (dot) dot.classList.toggle('is-stale', stale);
    setText(element('freshness-text'), stale ? 'poll stale' : 'live');
  }

  function poll() {
    fetch('/api/board', {
      method: 'GET',
      cache: 'no-store',
      headers: { 'X-Swarm-Token': token }
    }).then(function (response) {
      if (!response.ok) throw new Error('board request failed with ' + response.status);
      return response.json();
    }).then(function (board) {
      state.board = board;
      state.lastPollAt = Date.now();
      renderHeader(board);
      renderNeeds(board);
      renderDashboard(board);
      updateGraph(board);
      renderTasks(board);
      renderTimeline();
      refreshFreshness();
    }).catch(function () {
      refreshFreshness();
    }).then(function () {
      window.setTimeout(poll, POLL_MS);
    }, function () {
      window.setTimeout(poll, POLL_MS);
    });
  }

  state.cy = createGraph();
  var graphTab = element('graph-tab');
  var tasksTab = element('tasks-tab');
  if (graphTab && tasksTab) {
    graphTab.addEventListener('click', function () { setView('graph'); });
    tasksTab.addEventListener('click', function () { setView('tasks'); });
    [graphTab, tasksTab].forEach(function (tab, index) {
      tab.addEventListener('keydown', function (event) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' &&
            event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault();
        var target = event.key === 'Home' ||
          (event.key === 'ArrowLeft' && index === 1) ||
          (event.key === 'ArrowRight' && index === 1)
          ? graphTab
          : tasksTab;
        target.focus();
        setView(target === graphTab ? 'graph' : 'tasks');
      });
    });
  }
  var sortableHeaders = document.querySelectorAll('.task-table th[data-sort-key]');
  Array.prototype.forEach.call(sortableHeaders, function (header) {
    var button = header.querySelector('.sort-button');
    if (!button) return;
    button.addEventListener('click', function () {
      var key = header.getAttribute('data-sort-key');
      if (state.taskSortKey === key) {
        state.taskSortDir = state.taskSortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.taskSortKey = key;
        state.taskSortDir = 'asc';
      }
      if (state.board) renderTasks(state.board);
    });
  });
  var taskFilter = element('task-filter-input');
  if (taskFilter) {
    taskFilter.addEventListener('input', function () {
      state.taskFilter = taskFilter.value;
      if (state.board) renderTasks(state.board);
    });
  }
  var toggle = element('needs-only-toggle');
  if (toggle) {
    toggle.checked = state.onlyNeeds;
    toggle.addEventListener('change', function () {
      state.onlyNeeds = toggle.checked;
      if (state.board) renderNeeds(state.board);
      applyNeedsFilter();
      if (state.board) renderTasks(state.board);
    });
  }
  updateTaskSortHeaders();
  setView('graph');
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  if (media && media.addEventListener) {
    media.addEventListener('change', function () {
      if (state.cy) state.cy.style(cyStyles());
      disposeCharts();
      if (state.board) {
        renderDashboard(state.board);
        renderTimeline();
      }
    });
  }
  window.addEventListener('resize', function () {
    if (state.cy && state.view === 'graph') state.cy.resize();
    Object.keys(state.charts).forEach(function (key) {
      if (state.charts[key]) state.charts[key].resize();
    });
  });
  window.setInterval(refreshFreshness, 1000);
  refreshFreshness();
  poll();
}());
