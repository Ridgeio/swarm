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
    lastPollAt: 0
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
    return timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function safeDetail(value) {
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch (_error) {
      return String(value);
    }
  }

  function palette() {
    var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (dark) {
      return {
        ink: '#e2e8f0', muted: '#95a3b1', line: '#43515e', selected: '#61b7e4',
        claudeBg: '#392c63', claudeLine: '#9b83ff', codexBg: '#173f55', codexLine: '#52b7e8',
        grokBg: '#55272b', grokLine: '#e06a71', geminiBg: '#183f2d', geminiLine: '#58b886',
        a2aBg: '#503818', a2aLine: '#d69b38', headlessBg: '#333840', headlessLine: '#8e99a5',
        unknownBg: '#27323d', unknownLine: '#7f8d9a', activeBg: '#193d25', activeLine: '#4dc468',
        awaitingBg: '#4b3817', awaitingLine: '#e5a62c', staleBg: '#54242a', staleLine: '#f0646d',
        openBg: '#2b333c', openLine: '#818d99', debrisBg: '#4a321c', debrisLine: '#df8d32'
      };
    }
    return {
      ink: '#172033', muted: '#687481', line: '#aeb7bf', selected: '#1677a8',
      claudeBg: '#d9ccff', claudeLine: '#6d4aff', codexBg: '#c7e9ff', codexLine: '#1677a8',
      grokBg: '#ffd0d0', grokLine: '#bb3e3e', geminiBg: '#c9f2dc', geminiLine: '#27845a',
      a2aBg: '#ffe2ad', a2aLine: '#a86600', headlessBg: '#e4e4e7', headlessLine: '#71717a',
      unknownBg: '#f1f5f9', unknownLine: '#64748b', activeBg: '#c8f3d1', activeLine: '#238636',
      awaitingBg: '#ffe7a3', awaitingLine: '#b77900', staleBg: '#ffd0d0', staleLine: '#d1242f',
      openBg: '#e5e7eb', openLine: '#6b7280', debrisBg: '#ffd8a8', debrisLine: '#d97706'
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
          width: 'label', height: 'label', padding: '14px',
          color: color.ink, 'font-family': 'Avenir Next, Helvetica Neue, sans-serif',
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

  function renderHeader(board) {
    setText(element('swarm-name'), board.swarm.name);
    setText(element('agent-count'), board.agents.length);
    setText(element('task-count'), board.tasks.length);
    setText(element('updated-at'), timeLabel(board.generatedAt));
    document.title = board.swarm.name + ' · Swarm board';
  }

  function renderNeeds(board) {
    var list = element('needs-list');
    clear(list);
    setText(element('needs-count'), board.needsYou.length);
    if (board.needsYou.length === 0) {
      var quiet = document.createElement('li');
      quiet.className = 'quiet-item';
      quiet.textContent = 'Nothing needs you.';
      list.appendChild(quiet);
      return;
    }
    board.needsYou.forEach(function (need) {
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

  function detailRow(list, key, value) {
    var row = document.createElement('li');
    var term = document.createElement('span');
    var detail = document.createElement('span');
    row.className = 'detail-row';
    term.className = 'detail-key';
    detail.className = 'detail-value';
    term.textContent = key;
    detail.textContent = value === null || value === undefined || value === '' ? 'not recorded' : String(value);
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

  function inspectAgent(agent, board) {
    var body = element('inspector-body');
    var list = inspectorList(body);
    setText(element('inspector-title'), agent.name);
    detailRow(list, 'Host', agent.host);
    detailRow(list, 'Agent type', agent.agentType);
    detailRow(list, 'Heartbeat', ageLabel(agent.lastHeartbeat, board.generatedAt));
    detailRow(list, 'Current task', agent.currentTaskId || 'idle');
    detailRow(list, 'Progress evidence', ageLabel(agent.progressEvidenceAt, board.generatedAt));
    detailRow(list, 'Unacked', agent.unackedCount + (agent.unackedMaxAgeMin === null ? '' : ' · oldest ' + agent.unackedMaxAgeMin + 'm'));
    detailRow(list, 'Surface known', agent.surfaceKnown ? 'yes' : 'no');
  }

  function gitFacts(task) {
    if (!task.git) return 'not available';
    return (task.git.dirty ? 'dirty' : 'tracked clean') +
      ' · ' + task.git.untracked + ' untracked · ' + task.git.unpushed + ' unpushed';
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
    detailRow(list, 'Checkpoint', task.checkpoint ? task.checkpoint.ageMin + 'm ago · #' + task.checkpoint.seq : 'none');
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
    detailRow(list, 'Janitor tick', board.debris.tickAgeMin === null ? 'never' : board.debris.tickAgeMin + 'm ago');
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
      var path = document.createElement('div');
      var detail = document.createElement('div');
      item.className = 'finding-item';
      meta.className = 'finding-meta';
      path.className = 'event-summary';
      detail.className = 'finding-detail';
      meta.textContent = finding.kind + ' · ' + finding.state;
      path.textContent = finding.path;
      detail.textContent = safeDetail(finding.detail);
      item.appendChild(meta);
      item.appendChild(path);
      item.appendChild(detail);
      findings.appendChild(item);
    });
    body.appendChild(findings);
  }

  function inspectSelection(nodeId) {
    var board = state.board;
    var body = element('inspector-body');
    clear(body);
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

  function selectNode(nodeId) {
    if (!state.cy) return;
    state.cy.nodes().unselect();
    state.selectedId = nodeId;
    applySelection();
    inspectSelection(state.selectedId);
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
    inspectSelection(state.selectedId);
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
      updateGraph(board);
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
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  if (media && media.addEventListener) {
    media.addEventListener('change', function () {
      if (state.cy) state.cy.style(cyStyles());
    });
  }
  window.setInterval(refreshFreshness, 1000);
  refreshFreshness();
  poll();
}());
