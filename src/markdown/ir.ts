import MarkdownIt from "markdown-it";
import { chunkText } from "../auto-reply/chunk.js";
import type { MarkdownTableMode } from "../config/types.base.js";

type ListState = {
  type: "bullet" | "ordered";
  index: number;
};

type LinkState = {
  href: string;
  labelStart: number;
};

type RenderEnv = {
  listStack: ListState[];
};

type MarkdownToken = {
  type: string;
  content?: string;
  children?: MarkdownToken[];
  attrs?: [string, string][];
  attrGet?: (name: string) => string | null;
};

export type MarkdownStyle =
  | "bold"
  | "italic"
  | "strikethrough"
  | "code"
  | "code_block"
  | "spoiler"
  | "blockquote";

export type MarkdownStyleSpan = {
  start: number;
  end: number;
  style: MarkdownStyle;
};

export type MarkdownLinkSpan = {
  start: number;
  end: number;
  href: string;
};

export type MarkdownIR = {
  text: string;
  styles: MarkdownStyleSpan[];
  links: MarkdownLinkSpan[];
};

type OpenStyle = {
  style: MarkdownStyle;
  start: number;
};

type RenderTarget = {
  text: string;
  styles: MarkdownStyleSpan[];
  openStyles: OpenStyle[];
  links: MarkdownLinkSpan[];
  linkStack: LinkState[];
};

type TableCell = {
  text: string;
  styles: MarkdownStyleSpan[];
  links: MarkdownLinkSpan[];
};

type TableState = {
  headers: TableCell[];
  rows: TableCell[][];
  currentRow: TableCell[];
  currentCell: RenderTarget | null;
  inHeader: boolean;
};

type RenderState = RenderTarget & {
  env: RenderEnv;
  headingStyle: "none" | "bold";
  blockquotePrefix: string;
  enableSpoilers: boolean;
  tableMode: MarkdownTableMode;
  table: TableState | null;
  hasTables: boolean;
};

export type MarkdownParseOptions = {
  linkify?: boolean;
  enableSpoilers?: boolean;
  headingStyle?: "none" | "bold";
  blockquotePrefix?: string;
  autolink?: boolean;
  /** How to render tables (off|bullets|code|aligned). Default: off. */
  tableMode?: MarkdownTableMode;
};

function createMarkdownIt(options: MarkdownParseOptions): MarkdownIt {
  const md = new MarkdownIt({
    html: false,
    linkify: options.linkify ?? true,
    breaks: false,
    typographer: false,
  });
  md.enable("strikethrough");
  if (options.tableMode && options.tableMode !== "off") {
    md.enable("table");
  } else {
    md.disable("table");
  }
  if (options.autolink === false) {
    md.disable("autolink");
  }
  return md;
}

function getAttr(token: MarkdownToken, name: string): string | null {
  if (token.attrGet) {
    return token.attrGet(name);
  }
  if (token.attrs) {
    for (const [key, value] of token.attrs) {
      if (key === name) {
        return value;
      }
    }
  }
  return null;
}

function createTextToken(base: MarkdownToken, content: string): MarkdownToken {
  return { ...base, type: "text", content, children: undefined };
}

function applySpoilerTokens(tokens: MarkdownToken[]): void {
  for (const token of tokens) {
    if (token.children && token.children.length > 0) {
      token.children = injectSpoilersIntoInline(token.children);
    }
  }
}

function injectSpoilersIntoInline(tokens: MarkdownToken[]): MarkdownToken[] {
  const result: MarkdownToken[] = [];
  const state = { spoilerOpen: false };

  for (const token of tokens) {
    if (token.type !== "text") {
      result.push(token);
      continue;
    }

    const content = token.content ?? "";
    if (!content.includes("||")) {
      result.push(token);
      continue;
    }

    let index = 0;
    while (index < content.length) {
      const next = content.indexOf("||", index);
      if (next === -1) {
        if (index < content.length) {
          result.push(createTextToken(token, content.slice(index)));
        }
        break;
      }
      if (next > index) {
        result.push(createTextToken(token, content.slice(index, next)));
      }
      state.spoilerOpen = !state.spoilerOpen;
      result.push({
        type: state.spoilerOpen ? "spoiler_open" : "spoiler_close",
      });
      index = next + 2;
    }
  }

  return result;
}

function initRenderTarget(): RenderTarget {
  return {
    text: "",
    styles: [],
    openStyles: [],
    links: [],
    linkStack: [],
  };
}

function resolveRenderTarget(state: RenderState): RenderTarget {
  return state.table?.currentCell ?? state;
}

function appendText(state: RenderState, value: string) {
  if (!value) {
    return;
  }
  const target = resolveRenderTarget(state);
  target.text += value;
}

function openStyle(state: RenderState, style: MarkdownStyle) {
  const target = resolveRenderTarget(state);
  target.openStyles.push({ style, start: target.text.length });
}

function closeStyle(state: RenderState, style: MarkdownStyle) {
  const target = resolveRenderTarget(state);
  for (let i = target.openStyles.length - 1; i >= 0; i -= 1) {
    if (target.openStyles[i]?.style === style) {
      const start = target.openStyles[i].start;
      target.openStyles.splice(i, 1);
      const end = target.text.length;
      if (end > start) {
        target.styles.push({ start, end, style });
      }
      return;
    }
  }
}

function appendParagraphSeparator(state: RenderState) {
  if (state.env.listStack.length > 0) {
    return;
  }
  if (state.table) {
    return;
  } // Don't add paragraph separators inside tables
  state.text += "\n\n";
}

function appendListPrefix(state: RenderState) {
  const stack = state.env.listStack;
  const top = stack[stack.length - 1];
  if (!top) {
    return;
  }
  top.index += 1;
  const indent = "  ".repeat(Math.max(0, stack.length - 1));
  const prefix = top.type === "ordered" ? `${top.index}. ` : "• ";
  state.text += `${indent}${prefix}`;
}

function renderInlineCode(state: RenderState, content: string) {
  if (!content) {
    return;
  }
  const target = resolveRenderTarget(state);
  const start = target.text.length;
  target.text += content;
  target.styles.push({ start, end: start + content.length, style: "code" });
}

function renderCodeBlock(state: RenderState, content: string) {
  let code = content ?? "";
  if (!code.endsWith("\n")) {
    code = `${code}\n`;
  }
  const target = resolveRenderTarget(state);
  const start = target.text.length;
  target.text += code;
  target.styles.push({ start, end: start + code.length, style: "code_block" });
  if (state.env.listStack.length === 0) {
    target.text += "\n";
  }
}

function handleLinkClose(state: RenderState) {
  const target = resolveRenderTarget(state);
  const link = target.linkStack.pop();
  if (!link?.href) {
    return;
  }
  const href = link.href.trim();
  if (!href) {
    return;
  }
  const start = link.labelStart;
  const end = target.text.length;
  if (end <= start) {
    target.links.push({ start, end, href });
    return;
  }
  target.links.push({ start, end, href });
}

function initTableState(): TableState {
  return {
    headers: [],
    rows: [],
    currentRow: [],
    currentCell: null,
    inHeader: false,
  };
}

function finishTableCell(cell: RenderTarget): TableCell {
  closeRemainingStyles(cell);
  return {
    text: cell.text,
    styles: cell.styles,
    links: cell.links,
  };
}

function trimCell(cell: TableCell): TableCell {
  const text = cell.text;
  let start = 0;
  let end = text.length;
  while (start < end && /\s/.test(text[start] ?? "")) {
    start += 1;
  }
  while (end > start && /\s/.test(text[end - 1] ?? "")) {
    end -= 1;
  }
  if (start === 0 && end === text.length) {
    return cell;
  }
  const trimmedText = text.slice(start, end);
  const trimmedLength = trimmedText.length;
  const trimmedStyles: MarkdownStyleSpan[] = [];
  for (const span of cell.styles) {
    const sliceStart = Math.max(0, span.start - start);
    const sliceEnd = Math.min(trimmedLength, span.end - start);
    if (sliceEnd > sliceStart) {
      trimmedStyles.push({ start: sliceStart, end: sliceEnd, style: span.style });
    }
  }
  const trimmedLinks: MarkdownLinkSpan[] = [];
  for (const span of cell.links) {
    const sliceStart = Math.max(0, span.start - start);
    const sliceEnd = Math.min(trimmedLength, span.end - start);
    if (sliceEnd > sliceStart) {
      trimmedLinks.push({ start: sliceStart, end: sliceEnd, href: span.href });
    }
  }
  return { text: trimmedText, styles: trimmedStyles, links: trimmedLinks };
}

function appendCell(state: RenderState, cell: TableCell) {
  if (!cell.text) {
    return;
  }
  const start = state.text.length;
  state.text += cell.text;
  for (const span of cell.styles) {
    state.styles.push({
      start: start + span.start,
      end: start + span.end,
      style: span.style,
    });
  }
  for (const link of cell.links) {
    state.links.push({
      start: start + link.start,
      end: start + link.end,
      href: link.href,
    });
  }
}

function appendCellTextOnly(state: RenderState, cell: TableCell) {
  if (!cell.text) {
    return;
  }
  state.text += cell.text;
  // Do not append styles - this is used for code blocks where inner styles would overlap
}

function renderTableAsBullets(state: RenderState) {
  if (!state.table) {
    return;
  }
  const headers = state.table.headers.map(trimCell);
  const rows = state.table.rows.map((row) => row.map(trimCell));

  // If no headers or rows, skip
  if (headers.length === 0 && rows.length === 0) {
    return;
  }

  // Determine if first column should be used as row labels
  // (common pattern: first column is category/feature name)
  const useFirstColAsLabel = headers.length > 1 && rows.length > 0;

  if (useFirstColAsLabel) {
    // Format: each row becomes a section with header as row[0], then key:value pairs
    for (const row of rows) {
      if (row.length === 0) {
        continue;
      }

      const rowLabel = row[0];
      if (rowLabel?.text) {
        const labelStart = state.text.length;
        appendCell(state, rowLabel);
        const labelEnd = state.text.length;
        if (labelEnd > labelStart) {
          state.styles.push({ start: labelStart, end: labelEnd, style: "bold" });
        }
        state.text += "\n";
      }

      // Add each column as a bullet point
      for (let i = 1; i < row.length; i++) {
        const header = headers[i];
        const value = row[i];
        if (!value?.text) {
          continue;
        }
        state.text += "• ";
        if (header?.text) {
          appendCell(state, header);
          state.text += ": ";
        } else {
          state.text += `Column ${i}: `;
        }
        appendCell(state, value);
        state.text += "\n";
      }
      state.text += "\n";
    }
  } else {
    // Simple table: just list headers and values
    for (const row of rows) {
      for (let i = 0; i < row.length; i++) {
        const header = headers[i];
        const value = row[i];
        if (!value?.text) {
          continue;
        }
        state.text += "• ";
        if (header?.text) {
          appendCell(state, header);
          state.text += ": ";
        }
        appendCell(state, value);
        state.text += "\n";
      }
      state.text += "\n";
    }
  }
}

// Emoji mapping for table column headers when rendering as cards
// Ordered from most specific to most general to prevent broad patterns from stealing matches.
const HEADER_EMOJI_PATTERNS: Array<{ pattern: RegExp; emoji: string }> = [
  // --- Money & financial ---
  { pattern: /price|cost|msrp|budget|fee|amount|revenue|salary|wage|spend|worth|funding|investment|margin|profit|earning|remunerat|\$/i, emoji: "\uD83D\uDCB0" }, // 💰
  { pattern: /dividend|yield|roi|appreciat|growth|gain|upside/i, emoji: "\uD83D\uDCC8" },                                                                        // 📈
  { pattern: /loss|decline|decreas|drop|deficit|debt|depreciat|downturn/i, emoji: "\uD83D\uDCC9" },                                                               // 📉

  // --- People & org ---
  { pattern: /owner|person|who|author|assign|lead|manager|responsibl|creator|contribut|member|team|maintainer|reviewer|approver/i, emoji: "\uD83D\uDC64" },       // 👤
  { pattern: /company|organiz|firm|corp|employer|business|enterprise|vendor|supplier|manufacturer|publisher/i, emoji: "\uD83C\uDFE2" },                            // 🏢

  // --- Time & dates ---
  { pattern: /date|deadline|due|quarter|schedule|timeline|launch|release|eta|created|updated|modified/i, emoji: "\uD83D\uDCC5" },                                 // 📅
  { pattern: /duration|hours|minutes|runtime|elapsed|uptime|interval|latenc/i, emoji: "\uD83D\uDD50" },                                                           // 🕐

  // --- Status & workflow ---
  { pattern: /status|phase|progress|stage|workflow|step|milestone|lifecycle|condition/i, emoji: "\uD83D\uDD04" },                                                 // 🔄
  { pattern: /priority|urgenc|severity|importan|critical/i, emoji: "\uD83D\uDD34" },                                                                              // 🔴
  { pattern: /availab|support|enabl|compatibl|includ|verif|active|ready/i, emoji: "\u2705" },                                                                     // ✅

  // --- Purpose & use ---
  { pattern: /best\s*for|use\s*case|ideal|suited|purpose|recommend|target|audience|scenario|application|designed\s*for|intended/i, emoji: "\uD83C\uDFAF" },       // 🎯
  { pattern: /feature|advantage|pro|benefit|highlight|strength|perk|selling\s*point|differentiat|notable|unique/i, emoji: "\u2728" },                             // ✨
  { pattern: /disadvantage|weakness|limitation|drawback|caveat|downside|con(?:s|$)/i, emoji: "\u26A0\uFE0F" },                                                    // ⚠️
  { pattern: /result|outcome|winner|champion|award|achievement|verdict/i, emoji: "\uD83C\uDFC6" },                                                                // 🏆

  // --- Technical ---
  { pattern: /connect|interface|port|protocol|wireless|bluetooth|wifi|usb|hdmi|cable|adapter/i, emoji: "\uD83D\uDD0C" },                                         // 🔌
  { pattern: /arch|structure|frame|chassis|foundation|infrastructure|stack|system/i, emoji: "\uD83C\uDFD7\uFE0F" },                                               // 🏗️
  { pattern: /fuel|energy|motor|battery|electric|hybrid|propulsion|range|powertrain/i, emoji: "\uD83D\uDD0B" },                                                   // 🔋
  { pattern: /speed|performanc|throughput|bandwidth|response|benchmark|efficien/i, emoji: "\u26A1" },                                                              // ⚡
  { pattern: /technolog|tech|framework|software|tool|implementat|method|approach|technique|solution|strategy/i, emoji: "\uD83D\uDCBB" },                           // 💻
  { pattern: /security|access|permission|auth|encrypt|privacy|complian/i, emoji: "\uD83D\uDD12" },                                                                // 🔒
  { pattern: /platform|os|mobile|desktop|ios|android|windows|mac|browser|app/i, emoji: "\uD83D\uDCF1" },                                                          // 📱

  // --- Data & metrics ---
  { pattern: /metric|analytic|stats|chart|measur|kpi|data|telemetr/i, emoji: "\uD83D\uDCCA" },                                                                   // 📊
  { pattern: /score|rating|rank|grade|stars|review|points|evaluat|assess/i, emoji: "\u2B50" },                                                                    // ⭐
  { pattern: /count|quantity|number|total|qty|sum|tally/i, emoji: "\uD83D\uDD22" },                                                                               // 🔢
  { pattern: /size|dimension|weight|volume|capacity|height|width|depth|length/i, emoji: "\uD83D\uDCD0" },                                                         // 📐

  // --- Content & docs ---
  { pattern: /descript|details|notes|summary|about|info|remark|comment|explanation|overview|abstract|memo|context/i, emoji: "\uD83D\uDCDD" },                     // 📝
  { pattern: /feedback|review|response|reply|opinion|testimonial/i, emoji: "\uD83D\uDCAC" },                                                                      // 💬
  { pattern: /link|url|website|href|source|referenc|citat/i, emoji: "\uD83D\uDD17" },                                                                             // 🔗
  { pattern: /document|file|format|extension|attachment|report/i, emoji: "\uD83D\uDCC4" },                                                                        // 📄

  // --- Location & identity ---
  { pattern: /location|where|place|city|country|region|address|venue|office|territory|market|area|zone|province|headquarter/i, emoji: "\uD83D\uDCCD" },           // 📍
  { pattern: /language|locale|international|global|translat|i18n/i, emoji: "\uD83C\uDF10" },                                                                       // 🌐
  { pattern: /email|phone|fax|telegram|signal|whatsapp/i, emoji: "\u2709\uFE0F" },                                                                                // ✉️

  // --- Commerce & logistics ---
  { pattern: /package|shipping|delivery|logistic|order|warehouse|inventor|freight|dispatch/i, emoji: "\uD83D\uDCE6" },                                            // 📦

  // --- Broad/generic (last so they don't steal specific matches) ---
  { pattern: /sensitiv|risk|exposure|volatil|danger|hazard|threat/i, emoji: "\u26A0\uFE0F" },                                                                     // ⚠️
  { pattern: /category|type|class|kind|group|sector|genre|tier|division|segment|classificat|department|bucket|tag|label/i, emoji: "\uD83D\uDCCB" },               // 📋
  { pattern: /model|product|item|device|brand|name|title|identifier|sku|variant|edition|version/i, emoji: "\uD83C\uDFF7\uFE0F" },                                 // 🏷️
];

// Fallback palette for headers that don't match any pattern
const FALLBACK_EMOJIS = [
  "\uD83D\uDFE6", // 🟦 blue
  "\uD83D\uDFE7", // 🟧 orange
  "\uD83D\uDFE9", // 🟩 green
  "\uD83D\uDFEA", // 🟪 purple
  "\uD83D\uDFE5", // 🟥 red
  "\uD83D\uDFE8", // 🟨 yellow
  "\uD83D\uDFEB", // 🟫 brown
  "\u2B1B",        // ⬛ black
  "\u2B1C",        // ⬜ white
];

function assignHeaderEmojis(headers: TableCell[]): string[] {
  const used = new Set<string>();
  let fallbackIdx = 0;
  const result: string[] = [];

  for (const header of headers) {
    const text = header.text;
    let emoji: string | null = null;

    for (const entry of HEADER_EMOJI_PATTERNS) {
      if (entry.pattern.test(text) && !used.has(entry.emoji)) {
        emoji = entry.emoji;
        break;
      }
    }

    if (!emoji) {
      emoji = FALLBACK_EMOJIS[fallbackIdx % FALLBACK_EMOJIS.length];
      fallbackIdx++;
    }

    used.add(emoji);
    result.push(emoji);
  }

  return result;
}

function renderTableAsCards(
  state: RenderState,
  headers: TableCell[],
  rows: TableCell[][],
) {
  const MAX_LINE_WIDTH = 60;
  const emptyCell: TableCell = { text: "", styles: [], links: [] };
  // First column is the card title; remaining columns get emoji prefixes
  const emojis = assignHeaderEmojis(headers.slice(1));

  // Legend line: emoji + header name for each non-title column
  const legendParts: string[] = [];
  for (let i = 0; i < emojis.length; i++) {
    legendParts.push(`${emojis[i]} ${headers[i + 1]?.text ?? ""}`);
  }
  state.text += legendParts.join(" \u00B7 ") + "\n"; // · separator

  // Render each row as a card
  for (const row of rows) {
    // Zero-width space keeps the blank line non-empty so Discord message
    // chunking (chunk.ts) won't swallow it at a chunk boundary.
    state.text += "\u200B\n";

    // Card title (first column) - preserve cell styles, ensure bold
    const titleCell = row[0] ?? emptyCell;
    const titleStart = state.text.length;
    appendCell(state, titleCell);
    const titleEnd = state.text.length;
    // Add bold if the cell didn't already have it
    if (titleCell.text && !titleCell.styles.some((s) => s.style === "bold")) {
      state.styles.push({ start: titleStart, end: titleEnd, style: "bold" });
    }
    state.text += "\n";

    // Remaining columns as emoji-prefixed values, preserving cell styles
    let lineWidth = 0;
    let isFirstOnLine = true;

    for (let i = 0; i < emojis.length; i++) {
      const cell = row[i + 1] ?? emptyCell;
      if (!cell.text) continue;

      const emojiPrefix = `${emojis[i]} `;
      const separatorWidth = isFirstOnLine ? 0 : 3; // " · "
      const segmentWidth = emojiPrefix.length + cell.text.length;

      // Wrap to next line if this segment won't fit
      if (!isFirstOnLine && lineWidth + separatorWidth + segmentWidth > MAX_LINE_WIDTH) {
        state.text += "\n";
        lineWidth = 0;
        isFirstOnLine = true;
      }

      if (!isFirstOnLine) {
        state.text += " \u00B7 ";
        lineWidth += 3;
      }

      state.text += emojiPrefix;
      lineWidth += emojiPrefix.length;

      // Append cell value with styles preserved (bold, italic, etc. render outside code blocks)
      appendCell(state, cell);
      lineWidth += cell.text.length;

      isFirstOnLine = false;
    }

    if (!isFirstOnLine) {
      state.text += "\n";
    }
  }
}

function renderTableAsAligned(state: RenderState) {
  if (!state.table) {
    return;
  }
  const headers = state.table.headers.map(trimCell);
  const rows = state.table.rows.map((row) => row.map(trimCell));

  const colCount = Math.max(headers.length, ...rows.map((r) => r.length));
  if (colCount === 0) {
    return;
  }

  const MAX_TABLE_WIDTH = 60;
  const GAP_WIDTH = 4;

  // Measure ideal widths using plain text length
  const idealWidths: number[] = [];
  for (let i = 0; i < colCount; i++) {
    let max = headers[i]?.text.length ?? 0;
    for (const row of rows) {
      max = Math.max(max, row[i]?.text.length ?? 0);
    }
    idealWidths.push(max);
  }

  // Check if the table fits in one piece
  const totalWidth = idealWidths.reduce((a, b) => a + b, 0) + GAP_WIDTH * (colCount - 1);

  if (totalWidth <= MAX_TABLE_WIDTH) {
    // Table fits - render as aligned code block
    const codeStart = state.text.length;
    const allCols = Array.from({ length: colCount }, (_, i) => i);

    // Measure column widths
    const widths: number[] = [];
    for (let i = 0; i < colCount; i++) {
      let max = headers[i]?.text.length ?? 0;
      for (const row of rows) {
        max = Math.max(max, row[i]?.text.length ?? 0);
      }
      widths.push(max);
    }

    const gap = "    ";

    // Header row (plain text - styles are noise in code blocks)
    for (let i = 0; i < colCount; i++) {
      if (i > 0) state.text += gap;
      const text = headers[i]?.text ?? "";
      state.text += text;
      const pad = widths[i] - text.length;
      if (pad > 0) state.text += " ".repeat(pad);
    }
    state.text += "\n";

    // Separator
    const sepWidth = widths.reduce((a, b) => a + b, 0) + gap.length * (colCount - 1);
    state.text += "\u2500".repeat(sepWidth) + "\n";

    // Data rows (plain text)
    for (const row of rows) {
      for (let i = 0; i < colCount; i++) {
        if (i > 0) state.text += gap;
        const text = row[i]?.text ?? "";
        state.text += text;
        const pad = widths[i] - text.length;
        if (pad > 0) state.text += " ".repeat(pad);
      }
      state.text += "\n";
    }

    const codeEnd = state.text.length;
    if (codeEnd > codeStart) {
      state.styles.push({ start: codeStart, end: codeEnd, style: "code_block" });
    }
  } else {
    // Table too wide - render as emoji cards (no code block)
    renderTableAsCards(state, headers, rows);
  }

  if (state.env.listStack.length === 0) {
    state.text += "\n";
  }
}

function renderTableAsCode(state: RenderState) {
  if (!state.table) {
    return;
  }
  const headers = state.table.headers.map(trimCell);
  const rows = state.table.rows.map((row) => row.map(trimCell));

  const columnCount = Math.max(headers.length, ...rows.map((row) => row.length));
  if (columnCount === 0) {
    return;
  }

  const widths = Array.from({ length: columnCount }, () => 0);
  const updateWidths = (cells: TableCell[]) => {
    for (let i = 0; i < columnCount; i += 1) {
      const cell = cells[i];
      const width = cell?.text.length ?? 0;
      if (widths[i] < width) {
        widths[i] = width;
      }
    }
  };
  updateWidths(headers);
  for (const row of rows) {
    updateWidths(row);
  }

  const codeStart = state.text.length;

  const appendRow = (cells: TableCell[]) => {
    state.text += "|";
    for (let i = 0; i < columnCount; i += 1) {
      state.text += " ";
      const cell = cells[i];
      if (cell) {
        // Use text-only append to avoid overlapping styles with code_block
        appendCellTextOnly(state, cell);
      }
      const pad = widths[i] - (cell?.text.length ?? 0);
      if (pad > 0) {
        state.text += " ".repeat(pad);
      }
      state.text += " |";
    }
    state.text += "\n";
  };

  const appendDivider = () => {
    state.text += "|";
    for (let i = 0; i < columnCount; i += 1) {
      const dashCount = Math.max(3, widths[i]);
      state.text += ` ${"-".repeat(dashCount)} |`;
    }
    state.text += "\n";
  };

  appendRow(headers);
  appendDivider();
  for (const row of rows) {
    appendRow(row);
  }

  const codeEnd = state.text.length;
  if (codeEnd > codeStart) {
    state.styles.push({ start: codeStart, end: codeEnd, style: "code_block" });
  }
  if (state.env.listStack.length === 0) {
    state.text += "\n";
  }
}

function renderTokens(tokens: MarkdownToken[], state: RenderState): void {
  for (const token of tokens) {
    switch (token.type) {
      case "inline":
        if (token.children) {
          renderTokens(token.children, state);
        }
        break;
      case "text":
        appendText(state, token.content ?? "");
        break;
      case "em_open":
        openStyle(state, "italic");
        break;
      case "em_close":
        closeStyle(state, "italic");
        break;
      case "strong_open":
        openStyle(state, "bold");
        break;
      case "strong_close":
        closeStyle(state, "bold");
        break;
      case "s_open":
        openStyle(state, "strikethrough");
        break;
      case "s_close":
        closeStyle(state, "strikethrough");
        break;
      case "code_inline":
        renderInlineCode(state, token.content ?? "");
        break;
      case "spoiler_open":
        if (state.enableSpoilers) {
          openStyle(state, "spoiler");
        }
        break;
      case "spoiler_close":
        if (state.enableSpoilers) {
          closeStyle(state, "spoiler");
        }
        break;
      case "link_open": {
        const href = getAttr(token, "href") ?? "";
        const target = resolveRenderTarget(state);
        target.linkStack.push({ href, labelStart: target.text.length });
        break;
      }
      case "link_close":
        handleLinkClose(state);
        break;
      case "image":
        appendText(state, token.content ?? "");
        break;
      case "softbreak":
      case "hardbreak":
        appendText(state, "\n");
        break;
      case "paragraph_close":
        appendParagraphSeparator(state);
        break;
      case "heading_open":
        if (state.headingStyle === "bold") {
          openStyle(state, "bold");
        }
        break;
      case "heading_close":
        if (state.headingStyle === "bold") {
          closeStyle(state, "bold");
        }
        appendParagraphSeparator(state);
        break;
      case "blockquote_open":
        if (state.blockquotePrefix) {
          state.text += state.blockquotePrefix;
        }
        openStyle(state, "blockquote");
        break;
      case "blockquote_close":
        closeStyle(state, "blockquote");
        break;
      case "bullet_list_open":
        // Add newline before nested list starts (so nested items appear on new line)
        if (state.env.listStack.length > 0) {
          state.text += "\n";
        }
        state.env.listStack.push({ type: "bullet", index: 0 });
        break;
      case "bullet_list_close":
        state.env.listStack.pop();
        if (state.env.listStack.length === 0) {
          state.text += "\n";
        }
        break;
      case "ordered_list_open": {
        // Add newline before nested list starts (so nested items appear on new line)
        if (state.env.listStack.length > 0) {
          state.text += "\n";
        }
        const start = Number(getAttr(token, "start") ?? "1");
        state.env.listStack.push({ type: "ordered", index: start - 1 });
        break;
      }
      case "ordered_list_close":
        state.env.listStack.pop();
        if (state.env.listStack.length === 0) {
          state.text += "\n";
        }
        break;
      case "list_item_open":
        appendListPrefix(state);
        break;
      case "list_item_close":
        // Avoid double newlines (nested list's last item already added newline)
        if (!state.text.endsWith("\n")) {
          state.text += "\n";
        }
        break;
      case "code_block":
      case "fence":
        renderCodeBlock(state, token.content ?? "");
        break;
      case "html_block":
      case "html_inline":
        appendText(state, token.content ?? "");
        break;

      // Table handling
      case "table_open":
        if (state.tableMode !== "off") {
          state.table = initTableState();
          state.hasTables = true;
        }
        break;
      case "table_close":
        if (state.table) {
          if (state.tableMode === "bullets") {
            renderTableAsBullets(state);
          } else if (state.tableMode === "aligned") {
            renderTableAsAligned(state);
          } else if (state.tableMode === "code") {
            renderTableAsCode(state);
          }
        }
        state.table = null;
        break;
      case "thead_open":
        if (state.table) {
          state.table.inHeader = true;
        }
        break;
      case "thead_close":
        if (state.table) {
          state.table.inHeader = false;
        }
        break;
      case "tbody_open":
      case "tbody_close":
        break;
      case "tr_open":
        if (state.table) {
          state.table.currentRow = [];
        }
        break;
      case "tr_close":
        if (state.table) {
          if (state.table.inHeader) {
            state.table.headers = state.table.currentRow;
          } else {
            state.table.rows.push(state.table.currentRow);
          }
          state.table.currentRow = [];
        }
        break;
      case "th_open":
      case "td_open":
        if (state.table) {
          state.table.currentCell = initRenderTarget();
        }
        break;
      case "th_close":
      case "td_close":
        if (state.table?.currentCell) {
          state.table.currentRow.push(finishTableCell(state.table.currentCell));
          state.table.currentCell = null;
        }
        break;

      case "hr":
        // Render as a visual separator
        state.text += "───\n\n";
        break;
      default:
        if (token.children) {
          renderTokens(token.children, state);
        }
        break;
    }
  }
}

function closeRemainingStyles(target: RenderTarget) {
  for (let i = target.openStyles.length - 1; i >= 0; i -= 1) {
    const open = target.openStyles[i];
    const end = target.text.length;
    if (end > open.start) {
      target.styles.push({
        start: open.start,
        end,
        style: open.style,
      });
    }
  }
  target.openStyles = [];
}

function clampStyleSpans(spans: MarkdownStyleSpan[], maxLength: number): MarkdownStyleSpan[] {
  const clamped: MarkdownStyleSpan[] = [];
  for (const span of spans) {
    const start = Math.max(0, Math.min(span.start, maxLength));
    const end = Math.max(start, Math.min(span.end, maxLength));
    if (end > start) {
      clamped.push({ start, end, style: span.style });
    }
  }
  return clamped;
}

function clampLinkSpans(spans: MarkdownLinkSpan[], maxLength: number): MarkdownLinkSpan[] {
  const clamped: MarkdownLinkSpan[] = [];
  for (const span of spans) {
    const start = Math.max(0, Math.min(span.start, maxLength));
    const end = Math.max(start, Math.min(span.end, maxLength));
    if (end > start) {
      clamped.push({ start, end, href: span.href });
    }
  }
  return clamped;
}

function mergeStyleSpans(spans: MarkdownStyleSpan[]): MarkdownStyleSpan[] {
  const sorted = [...spans].toSorted((a, b) => {
    if (a.start !== b.start) {
      return a.start - b.start;
    }
    if (a.end !== b.end) {
      return a.end - b.end;
    }
    return a.style.localeCompare(b.style);
  });

  const merged: MarkdownStyleSpan[] = [];
  for (const span of sorted) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.style === span.style &&
      // Blockquotes are container blocks. Adjacent blockquote spans should not merge or
      // consecutive blockquotes can "style bleed" across the paragraph boundary.
      (span.start < prev.end || (span.start === prev.end && span.style !== "blockquote"))
    ) {
      prev.end = Math.max(prev.end, span.end);
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

function sliceStyleSpans(
  spans: MarkdownStyleSpan[],
  start: number,
  end: number,
): MarkdownStyleSpan[] {
  if (spans.length === 0) {
    return [];
  }
  const sliced: MarkdownStyleSpan[] = [];
  for (const span of spans) {
    const sliceStart = Math.max(span.start, start);
    const sliceEnd = Math.min(span.end, end);
    if (sliceEnd > sliceStart) {
      sliced.push({
        start: sliceStart - start,
        end: sliceEnd - start,
        style: span.style,
      });
    }
  }
  return mergeStyleSpans(sliced);
}

function sliceLinkSpans(spans: MarkdownLinkSpan[], start: number, end: number): MarkdownLinkSpan[] {
  if (spans.length === 0) {
    return [];
  }
  const sliced: MarkdownLinkSpan[] = [];
  for (const span of spans) {
    const sliceStart = Math.max(span.start, start);
    const sliceEnd = Math.min(span.end, end);
    if (sliceEnd > sliceStart) {
      sliced.push({
        start: sliceStart - start,
        end: sliceEnd - start,
        href: span.href,
      });
    }
  }
  return sliced;
}

export function markdownToIR(markdown: string, options: MarkdownParseOptions = {}): MarkdownIR {
  return markdownToIRWithMeta(markdown, options).ir;
}

export function markdownToIRWithMeta(
  markdown: string,
  options: MarkdownParseOptions = {},
): { ir: MarkdownIR; hasTables: boolean } {
  const env: RenderEnv = { listStack: [] };
  const md = createMarkdownIt(options);
  const tokens = md.parse(markdown ?? "", env as unknown as object);
  if (options.enableSpoilers) {
    applySpoilerTokens(tokens as MarkdownToken[]);
  }

  const tableMode = options.tableMode ?? "off";

  const state: RenderState = {
    text: "",
    styles: [],
    openStyles: [],
    links: [],
    linkStack: [],
    env,
    headingStyle: options.headingStyle ?? "none",
    blockquotePrefix: options.blockquotePrefix ?? "",
    enableSpoilers: options.enableSpoilers ?? false,
    tableMode,
    table: null,
    hasTables: false,
  };

  renderTokens(tokens as MarkdownToken[], state);
  closeRemainingStyles(state);

  const trimmedText = state.text.trimEnd();
  const trimmedLength = trimmedText.length;
  let codeBlockEnd = 0;
  for (const span of state.styles) {
    if (span.style !== "code_block") {
      continue;
    }
    if (span.end > codeBlockEnd) {
      codeBlockEnd = span.end;
    }
  }
  const finalLength = Math.max(trimmedLength, codeBlockEnd);
  const finalText =
    finalLength === state.text.length ? state.text : state.text.slice(0, finalLength);

  return {
    ir: {
      text: finalText,
      styles: mergeStyleSpans(clampStyleSpans(state.styles, finalLength)),
      links: clampLinkSpans(state.links, finalLength),
    },
    hasTables: state.hasTables,
  };
}

export function chunkMarkdownIR(ir: MarkdownIR, limit: number): MarkdownIR[] {
  if (!ir.text) {
    return [];
  }
  if (limit <= 0 || ir.text.length <= limit) {
    return [ir];
  }

  const chunks = chunkText(ir.text, limit);
  const results: MarkdownIR[] = [];
  let cursor = 0;

  chunks.forEach((chunk, index) => {
    if (!chunk) {
      return;
    }
    if (index > 0) {
      while (cursor < ir.text.length && /\s/.test(ir.text[cursor] ?? "")) {
        cursor += 1;
      }
    }
    const start = cursor;
    const end = Math.min(ir.text.length, start + chunk.length);
    results.push({
      text: chunk,
      styles: sliceStyleSpans(ir.styles, start, end),
      links: sliceLinkSpans(ir.links, start, end),
    });
    cursor = end;
  });

  return results;
}
