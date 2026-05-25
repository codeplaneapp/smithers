const NODE_WIDTH = 24;
const NODE_HEIGHT = 4;
const MAX_COLUMNS = 3;

function writeText(canvas, row, column, text) {
  if (row < 0 || row >= canvas.length) return;
  for (let index = 0; index < text.length; index += 1) {
    const target = column + index;
    if (target >= 0 && target < canvas[row].length) {
      canvas[row][target] = text[index];
    }
  }
}

function writeBox(canvas, row, column, width, height, lines) {
  writeText(canvas, row, column, `+${"-".repeat(width - 2)}+`);
  for (let offset = 1; offset < height - 1; offset += 1) {
    writeText(canvas, row + offset, column, `|${" ".repeat(width - 2)}|`);
  }
  writeText(canvas, row + height - 1, column, `+${"-".repeat(width - 2)}+`);
  lines.slice(0, height - 2).forEach((line, index) => {
    writeText(canvas, row + index + 1, column + 2, line.slice(0, width - 4).padEnd(width - 4));
  });
}

function writeHorizontal(canvas, row, fromColumn, toColumn) {
  const start = Math.min(fromColumn, toColumn);
  const end = Math.max(fromColumn, toColumn);
  for (let column = start; column <= end; column += 1) {
    if (row >= 0 && row < canvas.length && column >= 0 && column < canvas[row].length && canvas[row][column] === " ") {
      canvas[row][column] = "-";
    }
  }
}

function writeVertical(canvas, column, fromRow, toRow) {
  const start = Math.min(fromRow, toRow);
  const end = Math.max(fromRow, toRow);
  for (let row = start; row <= end; row += 1) {
    if (row >= 0 && row < canvas.length && column >= 0 && column < canvas[row].length && canvas[row][column] === " ") {
      canvas[row][column] = "|";
    }
  }
}

function markerForStatus(status) {
  if (status === "running") return "RUN";
  if (status === "complete") return "OK ";
  if (status === "cancelled") return "CAN";
  if (status === "error") return "ERR";
  return "RDY";
}

function compactLabel(label) {
  return label.replace("Capitalism", "Cap").replace("Communism", "Com").replace("Debate Loop", "Debate");
}

function compactId(id) {
  return id
    .replace("capitalism", "cap")
    .replace("communism", "com")
    .replace("round", "r")
    .replace("judge_final", "judge");
}

export function layoutWorkflowGraph(spec) {
  const byId = new Map(spec.nodes.map((node) => [node.id, node]));
  const layerById = new Map();

  function layerFor(node) {
    if (layerById.has(node.id)) return layerById.get(node.id);
    const layer =
      node.dependsOn.length === 0
        ? 0
        : Math.max(...node.dependsOn.map((dependency) => layerFor(byId.get(dependency) ?? { dependsOn: [] }))) + 1;
    layerById.set(node.id, layer);
    return layer;
  }

  spec.nodes.forEach(layerFor);

  const layers = new Map();
  for (const node of spec.nodes) {
    const layer = layerById.get(node.id) ?? 0;
    layers.set(layer, [...(layers.get(layer) ?? []), node]);
  }

  const maxLayer = Math.max(...layers.keys(), 0);
  const maxLaneCount = Math.max(...Array.from(layers.values()).map((nodes) => nodes.length), 1);
  const columnSpacing = NODE_WIDTH + 8;
  const rowSpacing = NODE_HEIGHT + 1;
  const columnCount = Math.min(maxLayer + 1, MAX_COLUMNS);
  const rowBandCount = Math.floor(maxLayer / MAX_COLUMNS) + 1;
  const width = (columnCount - 1) * columnSpacing + NODE_WIDTH + 4;
  const height = rowBandCount * maxLaneCount * rowSpacing + 2;
  const positions = new Map();

  for (const [layer, nodes] of layers.entries()) {
    nodes.forEach((node, lane) => {
      positions.set(node.id, {
        x: 2 + (layer % MAX_COLUMNS) * columnSpacing,
        y: 1 + (Math.floor(layer / MAX_COLUMNS) * maxLaneCount + lane) * rowSpacing,
      });
    });
  }

  return {
    width,
    height,
    positions,
    nodeWidth: NODE_WIDTH,
    nodeHeight: NODE_HEIGHT,
  };
}

export function findTuiNodeOverlaps(spec) {
  const layout = layoutWorkflowGraph(spec);
  const rects = spec.nodes.map((node) => {
    const position = layout.positions.get(node.id);
    return {
      id: node.id,
      left: position.x,
      top: position.y,
      right: position.x + layout.nodeWidth,
      bottom: position.y + layout.nodeHeight,
    };
  });
  const overlaps = [];

  for (let first = 0; first < rects.length; first += 1) {
    for (let second = first + 1; second < rects.length; second += 1) {
      const a = rects[first];
      const b = rects[second];
      if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) {
        overlaps.push([a.id, b.id]);
      }
    }
  }

  return overlaps;
}

export function renderWorkflowGraph(spec, statuses = {}) {
  const layout = layoutWorkflowGraph(spec);
  const canvas = Array.from({ length: layout.height }, () => Array.from({ length: layout.width }, () => " "));

  for (const node of spec.nodes) {
    const target = layout.positions.get(node.id);
    for (const dependencyId of node.dependsOn) {
      const source = layout.positions.get(dependencyId);
      if (!source || !target) continue;
      const sourceX = source.x + layout.nodeWidth;
      const sourceY = source.y + 1;
      const targetX = target.x - 1;
      const targetY = target.y + 1;
      const elbowX = Math.floor((sourceX + targetX) / 2);
      writeHorizontal(canvas, sourceY, sourceX, elbowX);
      writeVertical(canvas, elbowX, sourceY, targetY);
      writeHorizontal(canvas, targetY, elbowX, targetX);
      writeText(canvas, targetY, targetX, ">");
    }
  }

  for (const node of spec.nodes) {
    const position = layout.positions.get(node.id);
    const status = statuses[node.id] ?? "ready";
    writeBox(canvas, position.y, position.x, layout.nodeWidth, layout.nodeHeight, [
      `${markerForStatus(status)} ${compactLabel(node.label)}`,
      `[${node.kind}] ${compactId(node.id)}`,
    ]);
  }

  return canvas.map((row) => row.join("").trimEnd()).join("\n").trimEnd();
}
