(function (root, factory) {
  'use strict';
  var build = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = build;
  }
  if (root) {
    root.boardElements = build;
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

  return boardElements;
}));
