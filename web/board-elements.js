(function (root, factory) {
  'use strict';
  var build = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = build;
  }
  if (root) {
    root.boardElements = build;
    root.needsYouNodeIds = build.needsYouNodeIds;
    root.taskRows = build.taskRows;
    root.timelineRecords = build.timelineRecords;
  }
}(typeof window !== 'undefined' ? window :
  (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  function fragment(value) {
    var cleaned = String(value || 'unknown')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-');
    return cleaned || 'unknown';
  }

  function hostClass(host) {
    var value = String(host || '').toLowerCase();
    if (value.indexOf('claude') !== -1) return 'host-claude';
    if (value.indexOf('codex') !== -1) return 'host-codex';
    if (value.indexOf('grok') !== -1) return 'host-grok';
    if (value.indexOf('gemini') !== -1) return 'host-gemini';
    if (value.indexOf('a2a') !== -1) return 'host-a2a';
    if (value.indexOf('headless') !== -1) return 'host-headless';
    return 'host-unknown';
  }

  function taskLabel(task) {
    var evidence = task.checkpoint
      ? 'ckpt ' + task.checkpoint.ageMin + 'm'
      : 'no ckpt';
    return task.id + '\n' + task.state + ' · ' + evidence;
  }

  function debrisLabel(debris) {
    var counters = debris && debris.counters ? debris.counters : {};
    var findings = debris && Array.isArray(debris.findings) ? debris.findings.length : 0;
    return 'debris\n' + findings + ' findings · ' + (counters.unpushedCommits || 0) + ' unpushed';
  }

  function nodeId(kind, value) {
    return kind + ':' + String(value);
  }

  function stableHash(nodeIds, edgeTriples) {
    var input = nodeIds.slice().sort().join('\u001f') + '\u001e' +
      edgeTriples.slice().sort().join('\u001f');
    var hash = 2166136261;
    for (var index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return ('00000000' + (hash >>> 0).toString(16)).slice(-8);
  }

  function needsYouNodeIds(boardData) {
    var board = boardData || {};
    var needs = Array.isArray(board.needsYou) ? board.needsYou : [];
    var agents = Array.isArray(board.agents) ? board.agents : [];
    var tasks = Array.isArray(board.tasks) ? board.tasks : [];
    var found = Object.create(null);

    needs.forEach(function (need) {
      var refId = String(need && need.refId !== undefined ? need.refId : '');
      if (refId === 'janitor' || refId === 'debris') found.debris = true;
      tasks.forEach(function (task) {
        if (String(task.id) === refId) found[nodeId('task', task.id)] = true;
      });
      agents.forEach(function (agent) {
        if (String(agent.name).toLowerCase() === refId.toLowerCase()) {
          found[nodeId('agent', agent.name)] = true;
        }
      });
    });

    return Object.keys(found).sort();
  }

  var TASK_URGENCY = {
    awaiting_review: 0,
    active: 1,
    open: 2,
    done: 3
  };

  function compareText(left, right) {
    var a = String(left || '').toLowerCase();
    var b = String(right || '').toLowerCase();
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }

  function shortAction(value) {
    if (value.length <= 60) return value;
    return value.slice(0, 59) + '\u2026';
  }

  function gitLabel(git) {
    if (!git) return 'git n/a';
    var labels = [];
    if (git.dirty) labels.push('dirty');
    var unpushed = Number(git.unpushed || 0);
    if (unpushed > 0) labels.push('\u2191' + unpushed);
    return labels.length > 0 ? labels.join(' \u00b7 ') : 'clean';
  }

  function taskRows(boardData, opts) {
    var board = boardData || {};
    var options = opts || {};
    var tasks = Array.isArray(board.tasks) ? board.tasks : [];
    var filter = String(options.filter || '').trim().toLowerCase();
    var onlyNeeds = Boolean(options.onlyNeeds);
    var sortKey = String(options.sortKey || 'urgency');
    var direction = options.sortDir === 'desc' ? -1 : 1;
    var needed = Object.create(null);

    if (onlyNeeds) {
      needsYouNodeIds(board).forEach(function (id) { needed[id] = true; });
    }

    var entries = tasks.map(function (task, index) {
      var state = String(task.state || 'unknown');
      var owner = task.owner ? String(task.owner) : 'unowned';
      var checkpointAge = task.checkpoint && Number.isFinite(Number(task.checkpoint.ageMin))
        ? Number(task.checkpoint.ageMin)
        : null;
      var nextAction = task.checkpoint && task.checkpoint.nextAction
        ? String(task.checkpoint.nextAction)
        : 'not recorded';
      var row = {
        id: nodeId('task', task.id),
        slug: String(task.id),
        stateLabel: state,
        stateClass: 'st-' + fragment(state),
        stale: Boolean(task.stale),
        owner: owner,
        checkpointLabel: checkpointAge === null ? 'no ckpt' : checkpointAge + 'm ago',
        branch: task.branch ? String(task.branch) : 'no branch',
        gitLabel: gitLabel(task.git),
        nextActionFull: nextAction,
        nextActionShort: shortAction(nextAction)
      };
      return {
        index: index,
        row: row,
        checkpointAge: checkpointAge,
        unpushed: task.git ? Number(task.git.unpushed || 0) : 0
      };
    }).filter(function (entry) {
      if (onlyNeeds && !needed[entry.row.id]) return false;
      if (!filter) return true;
      return entry.row.slug.toLowerCase().indexOf(filter) !== -1 ||
        entry.row.owner.toLowerCase().indexOf(filter) !== -1;
    });

    entries.sort(function (left, right) {
      var comparison = 0;
      if (sortKey === 'urgency') {
        if (left.row.stale !== right.row.stale) return left.row.stale ? -1 : 1;
        var leftRank = Object.prototype.hasOwnProperty.call(TASK_URGENCY, left.row.stateLabel)
          ? TASK_URGENCY[left.row.stateLabel]
          : 4;
        var rightRank = Object.prototype.hasOwnProperty.call(TASK_URGENCY, right.row.stateLabel)
          ? TASK_URGENCY[right.row.stateLabel]
          : 4;
        comparison = leftRank - rightRank;
      } else if (sortKey === 'slug') {
        comparison = compareText(left.row.slug, right.row.slug) * direction;
      } else if (sortKey === 'state') {
        comparison = compareText(left.row.stateLabel, right.row.stateLabel) * direction;
      } else if (sortKey === 'owner') {
        comparison = compareText(left.row.owner, right.row.owner) * direction;
      } else if (sortKey === 'checkpoint-age') {
        if (left.checkpointAge === null || right.checkpointAge === null) {
          if (left.checkpointAge !== right.checkpointAge) {
            return left.checkpointAge === null ? 1 : -1;
          }
        } else {
          comparison = (left.checkpointAge - right.checkpointAge) * direction;
        }
      } else if (sortKey === 'unpushed-count') {
        comparison = (left.unpushed - right.unpushed) * direction;
      }
      return comparison || left.index - right.index;
    });

    return entries.map(function (entry) { return entry.row; });
  }

  var TIMELINE_COLORS = {
    started: '#3b82f6',
    checkpoint: '#22c55e',
    claimed: '#8b5cf6',
    handoff: '#f59e0b',
    closed: '#14b8a6',
    refused_stale_epoch: '#ef4444',
    other: '#94a3b8'
  };

  function timelineKind(kind) {
    var normalized = String(kind || '').toLowerCase();
    return Object.prototype.hasOwnProperty.call(TIMELINE_COLORS, normalized)
      ? normalized
      : 'other';
  }

  function timelineRecords(boardData, selectedTaskId) {
    var board = boardData || {};
    var timeline = Array.isArray(board.timeline) ? board.timeline : [];
    var filter = selectedTaskId === null || selectedTaskId === undefined
      ? null
      : String(selectedTaskId);
    var lanes = [];
    var laneSeen = Object.create(null);
    var records = [];

    timeline.forEach(function (event) {
      var taskId = String(event.taskId || 'unknown');
      if (filter !== null && taskId !== filter) return;
      if (!laneSeen[taskId]) {
        laneSeen[taskId] = true;
        lanes.push(taskId);
      }
      var kind = timelineKind(event.kind);
      records.push({
        taskId: taskId,
        lane: taskId,
        kind: kind,
        eventKind: String(event.kind || 'other'),
        color: TIMELINE_COLORS[kind],
        value: [event.at, taskId],
        event: event
      });
    });

    if (filter !== null && lanes.length === 0) lanes.push(filter);
    return { lanes: lanes, records: records };
  }

  function boardElements(boardData) {
    var board = boardData || {};
    var agents = Array.isArray(board.agents) ? board.agents : [];
    var tasks = Array.isArray(board.tasks) ? board.tasks : [];
    var edgeData = board.edges || {};
    var elements = [];
    var nodeIds = [];
    var edgeTriples = [];
    var agentIds = Object.create(null);
    var taskIds = Object.create(null);
    var tripleCounts = Object.create(null);

    agents.forEach(function (agent) {
      var id = nodeId('agent', agent.name);
      agentIds[String(agent.name).toLowerCase()] = id;
      nodeIds.push(id);
      elements.push({
        group: 'nodes',
        data: {
          id: id,
          kind: 'agent',
          refId: agent.name,
          name: agent.name,
          host: agent.host,
          label: agent.name + '\n' + agent.host
        },
        classes: 'agent ' + hostClass(agent.host)
      });
    });

    tasks.forEach(function (task) {
      var id = nodeId('task', task.id);
      var classes = 'task st-' + fragment(task.state);
      if (task.stale) classes += ' stale';
      taskIds[String(task.id)] = id;
      nodeIds.push(id);
      elements.push({
        group: 'nodes',
        data: {
          id: id,
          kind: 'task',
          refId: task.id,
          taskId: task.id,
          state: task.state,
          label: taskLabel(task)
        },
        classes: classes
      });
    });

    var debris = board.debris || { counters: {}, findings: [] };
    var debrisId = 'debris';
    var hasDebris = Array.isArray(debris.findings) && debris.findings.length > 0;
    nodeIds.push(debrisId);
    elements.push({
      group: 'nodes',
      data: {
        id: debrisId,
        kind: 'debris',
        refId: 'debris',
        label: debrisLabel(debris)
      },
      classes: hasDebris ? 'debris debris-warn' : 'debris'
    });

    function addEdge(kind, source, target, taskId, classes, label) {
      if (!source || !target) return;
      var triple = source + '\u0000' + kind + '\u0000' + target;
      var occurrence = tripleCounts[triple] || 0;
      tripleCounts[triple] = occurrence + 1;
      edgeTriples.push(triple);
      elements.push({
        group: 'edges',
        data: {
          id: 'edge:' + kind + ':' + source + ':' + target + ':' + occurrence,
          source: source,
          target: target,
          kind: kind,
          taskId: taskId,
          label: label
        },
        classes: classes
      });
    }

    (Array.isArray(edgeData.ownership) ? edgeData.ownership : []).forEach(function (edge) {
      addEdge(
        'owns',
        agentIds[String(edge.agent).toLowerCase()],
        taskIds[String(edge.taskId)],
        edge.taskId,
        'owns solid',
        'owns'
      );
    });

    (Array.isArray(edgeData.handoffs) ? edgeData.handoffs : []).forEach(function (edge) {
      addEdge(
        'handoff',
        agentIds[String(edge.from).toLowerCase()],
        agentIds[String(edge.to).toLowerCase()],
        edge.taskId,
        'handoff dashed',
        'handoff'
      );
    });

    (Array.isArray(edgeData.claims) ? edgeData.claims : []).forEach(function (edge) {
      addEdge(
        'claim',
        agentIds[String(edge.from).toLowerCase()],
        agentIds[String(edge.to).toLowerCase()],
        edge.taskId,
        'claim dotted',
        'claimed'
      );
    });

    return {
      elements: elements,
      topologyHash: stableHash(nodeIds, edgeTriples)
    };
  }

  boardElements.needsYouNodeIds = needsYouNodeIds;
  boardElements.taskRows = taskRows;
  boardElements.timelineRecords = timelineRecords;

  return boardElements;
}));
