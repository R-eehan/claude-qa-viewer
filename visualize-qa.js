#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// ─── Constants ───────────────────────────────────────────────────────────────
const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');
const OUTPUT_PATH = path.join(os.tmpdir(), 'claude-qa-sessions.html');
const OPEN_CMD = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';

// ─── Discovery ───────────────────────────────────────────────────────────────

function discoverSessionFiles() {
  const results = [];
  if (!fs.existsSync(CLAUDE_DIR)) {
    console.error(`Claude projects directory not found: ${CLAUDE_DIR}`);
    return results;
  }
  const projectDirs = fs.readdirSync(CLAUDE_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory());

  for (const dir of projectDirs) {
    const projectPath = path.join(CLAUDE_DIR, dir.name);
    const files = fs.readdirSync(projectPath, { withFileTypes: true })
      .filter(f => f.isFile() && f.name.endsWith('.jsonl'));
    for (const f of files) {
      results.push({
        filePath: path.join(projectPath, f.name),
        projectDir: dir.name,
        sessionId: f.name.replace('.jsonl', ''),
      });
    }
  }
  return results;
}

function extractProjectName(dirName) {
  // Convert "-Users-reehan-Desktop-ticket-summarizer" → "Ticket Summarizer"
  const parts = dirName.split('-').filter(Boolean);
  // Drop leading path segments (Users, username, Desktop, etc.)
  const desktopIdx = parts.findIndex(p => p.toLowerCase() === 'desktop');
  const meaningful = desktopIdx >= 0 ? parts.slice(desktopIdx + 1) : parts;
  if (meaningful.length === 0) return dirName;
  return meaningful.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ─── JSONL Parsing ───────────────────────────────────────────────────────────

function stripTags(str) {
  if (!str) return '';
  return str.replace(/<[^>]+>/g, '').trim();
}

function parseJSONLFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  const parsed = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch (e) {
      // skip malformed lines
    }
  }
  return parsed;
}

// ─── Q&A Extraction ──────────────────────────────────────────────────────────

function extractQAPairs(parsedLines) {
  // Pass 1: Index all AskUserQuestion tool_use blocks
  const toolUseMap = new Map(); // id → { questions, lineIndex, timestamp }
  for (let i = 0; i < parsedLines.length; i++) {
    const entry = parsedLines[i];
    if (entry.type !== 'assistant' || !entry.message?.content) continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
        toolUseMap.set(block.id, {
          questions: block.input?.questions || [],
          lineIndex: i,
          timestamp: entry.timestamp,
          toolUseId: block.id,
        });
      }
    }
  }

  // Pass 2: Find matching responses
  const pairs = [];
  for (let i = 0; i < parsedLines.length; i++) {
    const entry = parsedLines[i];
    if (entry.type !== 'user' || !entry.message?.content) continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type === 'tool_result' && toolUseMap.has(block.tool_use_id)) {
        // Skip errored responses
        if (block.is_error) continue;

        const askData = toolUseMap.get(block.tool_use_id);
        let answers = {};

        // Primary: use toolUseResult (structured)
        if (entry.toolUseResult?.answers) {
          answers = entry.toolUseResult.answers;
        } else {
          // Fallback: parse from content string
          answers = parseAnswersFromContent(block.content, askData.questions);
        }

        pairs.push({
          questions: askData.questions,
          answers,
          askTimestamp: askData.timestamp,
          answerTimestamp: entry.timestamp,
          askLineIndex: askData.lineIndex,
          answerLineIndex: i,
          toolUseId: askData.toolUseId,
        });
      }
    }
  }

  return pairs;
}

function parseAnswersFromContent(contentStr, questions) {
  // Fallback parser for the content string format:
  // "User has answered your questions: "Q1"="answer1", "Q2"="answer2"..."
  const answers = {};
  if (typeof contentStr !== 'string') return answers;
  for (const q of questions) {
    const qText = q.question;
    const pattern = `"${qText}"="`;
    const idx = contentStr.indexOf(pattern);
    if (idx === -1) continue;
    const start = idx + pattern.length;
    // Find the end — next `", "` or end of string before the final period
    let end = contentStr.indexOf('", "', start);
    if (end === -1) {
      end = contentStr.lastIndexOf('"');
      if (end <= start) end = contentStr.length;
    }
    answers[qText] = contentStr.substring(start, end);
  }
  return answers;
}

// ─── Session Metadata ────────────────────────────────────────────────────────

function extractSessionMeta(parsedLines, fileInfo) {
  let slug = '';
  let cwd = '';
  let startTime = '';
  let firstUserMessage = '';

  for (const entry of parsedLines) {
    if (!startTime && entry.timestamp) startTime = entry.timestamp;
    if (!slug && entry.slug) slug = entry.slug;
    if (!cwd && entry.cwd) cwd = entry.cwd;
    if (!firstUserMessage && entry.type === 'user') {
      const msg = entry.message;
      let candidate = '';
      if (typeof msg?.content === 'string') {
        candidate = msg.content;
      } else if (Array.isArray(msg?.content)) {
        const textBlock = msg.content.find(b => b.type === 'text');
        if (textBlock) candidate = textBlock.text || '';
      }
      // Skip system/command messages and tool results as "first user message"
      if (candidate && !candidate.startsWith('<command-') && !candidate.startsWith('<system-') && !candidate.includes('tool_result')) {
        firstUserMessage = candidate;
      }
    }
    if (slug && cwd && startTime && firstUserMessage) break;
  }

  return {
    sessionId: fileInfo.sessionId,
    projectDir: fileInfo.projectDir,
    projectName: extractProjectName(fileInfo.projectDir),
    slug: slug || fileInfo.sessionId.slice(0, 8),
    cwd,
    startTime,
    firstUserMessage: stripTags(firstUserMessage).slice(0, 300),
  };
}

// ─── Session Timeline ────────────────────────────────────────────────────────

function buildSessionTimeline(parsedLines) {
  const timeline = [];
  for (let i = 0; i < parsedLines.length; i++) {
    const entry = parsedLines[i];
    if (!entry.message || !entry.timestamp) continue;

    // Skip file-history-snapshot entries
    if (entry.type === 'file-history-snapshot') continue;

    const role = entry.type; // 'user' or 'assistant'
    const content = entry.message.content;

    if (role === 'assistant') {
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === 'thinking') continue; // skip thinking blocks
        if (block.type === 'text' && block.text?.trim()) {
          const cleaned = stripTags(block.text);
          if (cleaned.length < 3) continue; // skip empty/trivial
          timeline.push({
            type: 'assistant_text',
            timestamp: entry.timestamp,
            content: cleaned,
            lineIndex: i,
          });
        } else if (block.type === 'tool_use') {
          if (block.name === 'AskUserQuestion') {
            timeline.push({
              type: 'ask_user_question',
              timestamp: entry.timestamp,
              toolUseId: block.id,
              questions: block.input?.questions || [],
              lineIndex: i,
            });
          } else {
            const snippet = summarizeToolInput(block);
            timeline.push({
              type: 'tool_use',
              timestamp: entry.timestamp,
              toolName: block.name,
              content: snippet,
              lineIndex: i,
            });
          }
        }
      }
    } else if (role === 'user') {
      if (typeof content === 'string') {
        const cleaned = stripTags(content);
        if (cleaned.length >= 3) {
          timeline.push({
            type: 'user_text',
            timestamp: entry.timestamp,
            content: cleaned,
            lineIndex: i,
          });
        }
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            const cleaned = stripTags(block.text || '');
            // Skip system-injected text (system reminders, command tags, etc.)
            if (cleaned.length < 3) continue;
            if (/^(SessionStart|currentDate|Today|The following|As you answer)/i.test(cleaned)) continue;
            timeline.push({
              type: 'user_text',
              timestamp: entry.timestamp,
              content: cleaned,
              lineIndex: i,
            });
          } else if (block.type === 'tool_result') {
            // Only keep AskUserQuestion responses; skip all other tool results (noise)
            if (entry.toolUseResult) {
              timeline.push({
                type: 'user_answer',
                timestamp: entry.timestamp,
                toolUseId: block.tool_use_id,
                answers: entry.toolUseResult.answers || {},
                lineIndex: i,
              });
            }
            // tool_result entries (Bash output, file reads, etc.) are omitted — they're noise
          }
        }
      }
    }
  }
  return timeline;
}

function summarizeToolInput(block) {
  const input = block.input;
  if (!input) return '';
  if (input.command) return input.command.slice(0, 120);
  if (input.file_path) return input.file_path;
  if (input.pattern) return `pattern: ${input.pattern}`;
  if (input.query) return input.query.slice(0, 120);
  if (input.url) return input.url;
  if (input.content) return input.content.slice(0, 120);
  return JSON.stringify(input).slice(0, 120);
}

// ─── Data Transformation ─────────────────────────────────────────────────────

function buildViewModel(allSessions) {
  const withQA = allSessions.filter(s => s.qaPairs.length > 0);
  const totalSessions = allSessions.length;
  const projectSet = new Set(allSessions.map(s => s.meta.projectName));
  const qaSessionCount = withQA.length;
  const totalQA = withQA.reduce((sum, s) => sum + s.qaPairs.length, 0);

  // Sort by date descending
  withQA.sort((a, b) => new Date(b.meta.startTime) - new Date(a.meta.startTime));

  // Group by project
  const grouped = {};
  for (const session of withQA) {
    const proj = session.meta.projectName;
    if (!grouped[proj]) grouped[proj] = [];
    grouped[proj].push(session);
  }

  return {
    totalSessions,
    totalProjects: projectSet.size,
    qaSessionCount,
    totalQA,
    grouped,
    sessions: withQA,
  };
}

// ─── HTML Generation ─────────────────────────────────────────────────────────

function generateHTML(viewModel) {
  return `<!DOCTYPE html>
<html lang="en" class="">
<head>
<meta charset="utf-8"/>
<meta content="width=device-width, initial-scale=1.0" name="viewport"/>
<title>Q&A Sessions — Claude Code Retrospective</title>
<link href="https://fonts.googleapis.com" rel="preconnect"/>
<link crossorigin="" href="https://fonts.gstatic.com" rel="preconnect"/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400;1,6..72,500&display=swap" rel="stylesheet"/>
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet"/>
<script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
<script>
tailwind.config = {
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        "primary": "#D97706",
        "ink": "#2C2C2C",
        "paper": "#F9F8F4",
        "slate-log": "#5F6B7C",
        "amber-light": "#FDE68A",
        "border-subtle": "#E5E2D9",
        "surface": "#FFFFFF",
      },
      fontFamily: {
        "serif": ["Newsreader", "serif"],
        "mono": ["JetBrains Mono", "monospace"],
        "sans": ["Inter", "sans-serif"],
      },
      borderRadius: {
        "sm": "2px",
        "md": "4px",
      },
      boxShadow: {
        'paper': '0 20px 40px rgba(0,0,0,0.05)',
      }
    },
  },
}
</script>
<style>
:root {
  --bg-page: #F9F8F4;
  --bg-surface: #FFFFFF;
  --bg-hover: #F0EFE9;
  --text-primary: #2C2C2C;
  --text-secondary: #5F6B7C;
  --text-muted: #9CA3AF;
  --border: #E5E2D9;
  --amber-light: #FDE68A;
  --amber-dark-bg: rgba(253, 230, 138, 0.3);
  --primary: #D97706;
  --qa-header-bg: #FDE68A;
  --qa-body-bg: #FFFFFF;
  --badge-bg: #FEF3C7;
  --badge-text: #92400E;
  --card-bg: #FFFFFF;
  --card-border: #E5E2D9;
  --scrollbar-track: #F9F8F4;
  --scrollbar-thumb: #E5E2D9;
}

.dark {
  --bg-page: #0f1117;
  --bg-surface: #1a1d27;
  --bg-hover: #242836;
  --text-primary: #E5E7EB;
  --text-secondary: #9CA3AF;
  --text-muted: #6B7280;
  --border: #2d3141;
  --amber-light: #FDE68A;
  --amber-dark-bg: #2a2518;
  --primary: #e8b931;
  --qa-header-bg: #2a2518;
  --qa-body-bg: #1a1d27;
  --badge-bg: #2a2518;
  --badge-text: #e8b931;
  --card-bg: #1a1d27;
  --card-border: #2d3141;
  --scrollbar-track: #0f1117;
  --scrollbar-thumb: #2d3141;
}

body {
  background: var(--bg-page);
  color: var(--text-primary);
}

::-webkit-scrollbar { width: 8px; }
::-webkit-scrollbar-track { background: var(--scrollbar-track); }
::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 2px; }
::-webkit-scrollbar-thumb:hover { background: var(--primary); }

::selection {
  background: var(--amber-light);
  color: #2C2C2C;
}

.timeline-gutter::after {
  content: '';
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 1px;
  background-color: var(--border);
}

.qa-card-header { background: var(--qa-header-bg); }
.qa-card-body { background: var(--qa-body-bg); }
.session-card {
  background: var(--card-bg);
  border-color: var(--card-border);
  transition: all 0.15s ease;
}
.session-card:hover {
  border-color: var(--primary);
  box-shadow: 0 2px 8px rgba(217, 119, 6, 0.1);
}

.badge-qa {
  background: var(--badge-bg);
  color: var(--badge-text);
}

.option-pill {
  border: 1px solid var(--border);
  background: var(--bg-surface);
  color: var(--text-secondary);
  transition: all 0.15s ease;
}
.option-pill.selected {
  border-color: var(--primary);
  background: var(--badge-bg);
  color: var(--badge-text);
  font-weight: 500;
}

.filter-btn {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  color: var(--text-primary);
  transition: all 0.15s ease;
}
.filter-btn:hover { border-color: var(--text-primary); }
.filter-btn.active {
  background: var(--primary);
  border-color: var(--primary);
  color: white;
}

/* Conversation entries (tier 2) */
.conv-entry {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  transition: border-color 0.15s ease;
}
.conv-entry:hover {
  border-color: color-mix(in srgb, var(--text-muted) 40%, transparent);
}
.conv-entry .conv-body {
  overflow: hidden;
  position: relative;
}
.conv-entry .conv-body.truncated {
  max-height: 4.5em;
}
.conv-entry .conv-body.truncated::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 2em;
  background: linear-gradient(transparent, var(--bg-surface));
  pointer-events: none;
}
.conv-entry .conv-body.expanded {
  max-height: 400px;
  overflow-y: auto;
}
.conv-entry .conv-body.expanded::-webkit-scrollbar { width: 4px; }
.conv-entry .conv-body.expanded::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
.conv-expand-btn {
  color: var(--text-muted);
  cursor: pointer;
  transition: color 0.15s ease;
}
.conv-expand-btn:hover {
  color: var(--primary);
}

/* Tool pills (tier 3) */
.tool-pill {
  transition: background 0.1s ease;
}
.tool-pill:hover { background: var(--bg-hover); }

.back-link {
  color: var(--text-secondary);
  transition: color 0.15s ease;
}
.back-link:hover { color: var(--primary); }

.view-header {
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 64px; /* below the main header (h-16 = 64px) */
  z-index: 40;
  background: var(--bg-page);
  backdrop-filter: blur(8px);
  background-color: color-mix(in srgb, var(--bg-page) 95%, transparent);
}

/* Back to top button */
.back-to-top {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 60;
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  border: none;
  background: var(--primary);
  color: #FFFFFF;
  cursor: pointer;
  opacity: 0;
  transform: translateY(12px) scale(0.9);
  transition: opacity 0.25s ease, transform 0.25s ease, box-shadow 0.15s ease;
  pointer-events: none;
  box-shadow: 0 4px 14px rgba(217, 119, 6, 0.35);
}
.back-to-top.visible {
  opacity: 1;
  transform: translateY(0) scale(1);
  pointer-events: auto;
}
.back-to-top:hover {
  box-shadow: 0 6px 20px rgba(217, 119, 6, 0.5);
  transform: translateY(-1px) scale(1);
}
.back-to-top:active {
  transform: translateY(0) scale(0.96);
}

/* Fade in animation */
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
.fade-in { animation: fadeIn 0.2s ease forwards; }
</style>
</head>
<body class="antialiased font-serif overflow-y-scroll h-screen">

<div class="flex flex-col min-h-screen max-w-[1024px] mx-auto border-x" style="border-color: var(--border);">

<!-- Sticky Header -->
<header class="sticky top-0 z-50 flex items-center justify-between px-6 h-16 border-b backdrop-blur-sm" style="background: var(--bg-page); border-color: var(--border); background-color: color-mix(in srgb, var(--bg-page) 95%, transparent);">
  <div class="flex items-center gap-3">
    <span class="material-symbols-outlined opacity-80" style="font-size: 20px; color: var(--primary);">forum</span>
    <h1 class="text-lg font-semibold tracking-tight font-sans">Q&A Retrospective</h1>
  </div>
  <div class="flex items-center gap-3">
    <span class="text-xs font-mono" style="color: var(--text-primary);">
      Analyzed ${viewModel.totalSessions} sessions across ${viewModel.totalProjects} projects — ${viewModel.qaSessionCount} contain Q&A
    </span>
    <button onclick="toggleTheme()" id="theme-toggle" class="flex items-center justify-center w-8 h-8 rounded-sm hover:opacity-80 transition-opacity" style="background: var(--bg-surface); border: 1px solid var(--border);" title="Toggle theme">
      <span class="material-symbols-outlined" style="font-size: 18px;" id="theme-icon">dark_mode</span>
    </button>
  </div>
</header>

<!-- Session List View -->
<div id="session-list" class="flex-1 px-6 py-8">
  ${generateSessionListHTML(viewModel)}
</div>

<!-- Session Detail View (rendered by client JS) -->
<div id="session-detail" class="flex-1 hidden"></div>

</div>

<!-- Back to top button -->
<button id="back-to-top" class="back-to-top" onclick="window.scrollTo({top:0,behavior:'smooth'})" title="Back to top">
  <span class="material-symbols-outlined" style="font-size: 20px;">arrow_upward</span>
</button>

<script>
// ─── Embedded Data ──────────────────────────────────────────────────────────
const SESSION_DATA = ${JSON.stringify(viewModel.sessions.map(s => ({
  id: s.meta.sessionId,
  slug: s.meta.slug,
  projectName: s.meta.projectName,
  startTime: s.meta.startTime,
  firstUserMessage: s.meta.firstUserMessage,
  cwd: s.meta.cwd,
  qaCount: s.qaPairs.length,
  qaPairs: s.qaPairs,
  timeline: s.timeline,
}))).replace(/<\//g, '<\\/')};

${generateClientJS()}
</script>
</body>
</html>`;
}

function generateSessionListHTML(viewModel) {
  let html = '';

  // Info disclaimer about session names
  html += `
    <div class="mb-8 pl-3 border-l-2" style="border-left-color: var(--primary);">
      <p class="text-sm font-serif italic leading-relaxed" style="color: var(--text-secondary);">
        Session names are randomly generated by Claude Code. Use <code class="font-mono text-xs px-1 py-0.5 rounded-sm" style="background: var(--bg-hover); color: var(--primary);">/rename</code> in any active session to give it a meaningful title.
        <a href="https://code.claude.com/docs/en/interactive-mode#built-in-commands" target="_blank" rel="noopener" class="font-sans text-xs font-medium ml-1 no-underline hover:underline" style="color: var(--primary);">Docs <span style="display: inline-block; transform: rotate(-45deg);">&rarr;</span></a>
      </p>
    </div>`;

  const projectNames = Object.keys(viewModel.grouped).sort();

  for (const projectName of projectNames) {
    const sessions = viewModel.grouped[projectName];
    html += `
    <div class="mb-10">
      <div class="flex items-center gap-3 mb-4">
        <span class="material-symbols-outlined" style="font-size: 16px; color: var(--text-muted);">folder</span>
        <h2 class="text-sm font-mono uppercase tracking-widest" style="color: var(--text-muted);">${escapeHTML(projectName)}</h2>
        <div class="h-px flex-1" style="background: var(--border);"></div>
      </div>
      <div class="grid gap-3">`;

    for (const session of sessions) {
      const date = formatDate(session.meta.startTime);
      const time = formatTime(session.meta.startTime);
      const preview = escapeHTML(session.meta.firstUserMessage.slice(0, 160));
      const slug = escapeHTML(session.meta.slug);

      html += `
        <a href="#session/${session.meta.sessionId}" class="session-card block border rounded-sm px-5 py-4 cursor-pointer no-underline" style="color: inherit;">
          <div class="flex items-start justify-between gap-4">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1.5">
                <span class="text-sm font-mono font-medium" style="color: var(--primary);">${slug}</span>
                <span class="text-xs font-mono" style="color: var(--text-muted);">${date} ${time}</span>
              </div>
              <p class="text-sm leading-relaxed line-clamp-2" style="color: var(--text-secondary);">${preview}</p>
            </div>
            <span class="badge-qa inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-mono font-bold flex-shrink-0">
              <span class="material-symbols-outlined" style="font-size: 14px;">question_answer</span>
              ${session.qaPairs.length}
            </span>
          </div>
        </a>`;
    }

    html += `
      </div>
    </div>`;
  }

  return html;
}

function generateClientJS() {
  return `
// ─── Theme ────────────────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('qa-viz-theme');
  if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
    document.getElementById('theme-icon').textContent = 'light_mode';
  }
}
function toggleTheme() {
  const html = document.documentElement;
  html.classList.toggle('dark');
  const isDark = html.classList.contains('dark');
  localStorage.setItem('qa-viz-theme', isDark ? 'dark' : 'light');
  document.getElementById('theme-icon').textContent = isDark ? 'light_mode' : 'dark_mode';
}
initTheme();

// ─── Utilities ────────────────────────────────────────────────────────────
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// ─── Router ───────────────────────────────────────────────────────────────
let currentFilter = 'all'; // 'all' or 'qa'
const qaRegistry = {}; // id → {questions, answers} for Copy JSON

function initRouter() {
  window.addEventListener('hashchange', handleRoute);
  handleRoute();
}

function handleRoute() {
  const hash = location.hash || '#/';
  if (hash.startsWith('#session/')) {
    const id = hash.replace('#session/', '');
    showSessionDetail(id);
  } else {
    showSessionList();
  }
}

function showSessionList() {
  document.getElementById('session-list').classList.remove('hidden');
  document.getElementById('session-detail').classList.add('hidden');
}

function showSessionDetail(id) {
  const session = SESSION_DATA.find(s => s.id === id);
  if (!session) {
    location.hash = '#/';
    return;
  }
  document.getElementById('session-list').classList.add('hidden');
  const detail = document.getElementById('session-detail');
  detail.classList.remove('hidden');
  currentFilter = 'all';
  renderSessionDetail(session, detail);
  applyTruncation();
}

// ─── Session Detail Rendering ─────────────────────────────────────────────
function renderSessionDetail(session, container) {
  // Build Q&A lookup by toolUseId for inline rendering
  const qaByToolUseId = {};
  for (const pair of session.qaPairs) {
    qaByToolUseId[pair.toolUseId] = pair;
  }

  // Build answer lookup by toolUseId
  const answerByToolUseId = {};
  for (const pair of session.qaPairs) {
    answerByToolUseId[pair.toolUseId] = pair;
  }

  let html = '';

  // Header
  html += '<div class="view-header px-6 py-4 fade-in">';
  html += '  <div class="flex items-center justify-between">';
  html += '    <div class="flex items-center gap-3">';
  html += '      <a href="#/" class="back-link flex items-center gap-1 text-sm font-sans no-underline">';
  html += '        <span class="material-symbols-outlined" style="font-size: 18px;">arrow_back</span>';
  html += '        Sessions';
  html += '      </a>';
  html += '      <span style="color: var(--text-muted);">·</span>';
  html += '      <span class="text-sm font-mono font-medium" style="color: var(--primary);">' + esc(session.slug) + '</span>';
  html += '      <span class="badge-qa inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-mono font-bold">';
  html += '        ' + session.qaCount + ' Q&A';
  html += '      </span>';
  html += '    </div>';
  html += '    <div class="flex items-center gap-2">';
  html += '      <button onclick="setFilter(\\'all\\')" id="filter-all" class="filter-btn px-3 py-1 text-xs font-mono rounded-sm active">All</button>';
  html += '      <button onclick="setFilter(\\'qa\\')" id="filter-qa" class="filter-btn px-3 py-1 text-xs font-mono rounded-sm">Q&A Only</button>';
  html += '    </div>';
  html += '  </div>';
  html += '  <div class="mt-2 flex items-center gap-3 text-xs font-mono" style="color: var(--text-muted);">';
  html += '    <span>' + formatDate(session.startTime) + '</span>';
  html += '    <span>·</span>';
  html += '    <span>' + esc(session.projectName) + '</span>';
  html += '    <span>·</span>';
  html += '    <span>' + esc(session.cwd) + '</span>';
  html += '  </div>';
  html += '</div>';

  // Timeline
  html += '<div class="flex flex-1 relative">';
  html += '  <div class="hidden md:block w-[60px] flex-shrink-0 relative timeline-gutter"></div>';
  html += '  <div class="flex-1 px-4 py-6 md:px-0">';
  html += '    <div id="timeline-content" class="max-w-[640px] mx-auto flex flex-col gap-0.5">';
  html += renderTimeline(session, qaByToolUseId, answerByToolUseId);
  html += '    </div>';
  html += '  </div>';
  html += '</div>';

  container.innerHTML = html;

  // Store session ref for filter toggling
  container._session = session;
  container._qaByToolUseId = qaByToolUseId;
  container._answerByToolUseId = answerByToolUseId;
}

function renderTimeline(session, qaByToolUseId, answerByToolUseId) {
  let html = '';
  const timeline = session.timeline;
  const renderedQAIds = new Set();

  for (let i = 0; i < timeline.length; i++) {
    const entry = timeline[i];

    if (entry.type === 'ask_user_question') {
      const pair = qaByToolUseId[entry.toolUseId];
      if (pair && !renderedQAIds.has(entry.toolUseId)) {
        renderedQAIds.add(entry.toolUseId);
        html += renderQACard(pair, entry.timestamp);
      }
      continue;
    }

    if (entry.type === 'user_answer') {
      // Already rendered as part of QA card
      continue;
    }

    // Regular timeline entries (hidden in QA-only mode)
    if (currentFilter === 'qa') continue;

    html += renderTimelineEntry(entry);
  }

  return html;
}

function renderQACard(pair, timestamp) {
  let html = '';
  html += '<div class="relative my-4 -mx-4 md:-mx-8 fade-in qa-card-wrapper">';
  html += '  <div class="absolute left-0 top-6 w-full h-px border-t border-dashed opacity-30" style="border-color: var(--primary);"></div>';
  html += '  <div style="background: var(--amber-dark-bg);" class="border-y" style="border-color: color-mix(in srgb, var(--primary) 20%, transparent);">';
  html += '    <div class="max-w-[640px] mx-auto border-l-2 shadow-sm" style="background: var(--bg-surface); border-left-color: var(--primary);">';

  // Header
  html += '      <div class="qa-card-header px-6 py-4 border-b" style="border-color: color-mix(in srgb, var(--primary) 10%, transparent);">';
  html += '        <div class="flex items-center gap-2 mb-1">';
  html += '          <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-white text-[10px] font-mono uppercase tracking-wider font-bold" style="background: var(--primary);">Claude Asked</span>';
  if (timestamp) {
    html += '          <span class="text-[11px] font-mono" style="color: var(--text-muted);">' + formatTime(timestamp) + '</span>';
  }
  html += '        </div>';
  html += '      </div>';

  // Questions & Answers
  for (let q = 0; q < pair.questions.length; q++) {
    const question = pair.questions[q];
    const answerText = pair.answers[question.question] || '';

    html += '      <div class="px-6 py-5 ' + (q > 0 ? 'border-t' : '') + '" style="' + (q > 0 ? 'border-color: var(--border);' : '') + 'background: var(--qa-body-bg);">';

    // Question
    html += '        <div class="mb-4">';
    if (question.header) {
      html += '          <span class="text-[10px] font-mono uppercase tracking-widest mb-1 block" style="color: var(--text-muted);">' + esc(question.header) + '</span>';
    }
    html += '          <p class="font-serif italic text-lg leading-relaxed" style="color: var(--text-primary);">"' + esc(question.question) + '"</p>';
    html += '        </div>';

    // Options as pills
    if (question.options && question.options.length > 0) {
      html += '        <div class="flex flex-wrap gap-2 mb-4">';
      for (const opt of question.options) {
        const isSelected = answerText.toLowerCase().includes(opt.label.toLowerCase());
        html += '          <span class="option-pill px-3 py-1 rounded-full text-xs font-sans' + (isSelected ? ' selected' : '') + '" title="' + esc(opt.description) + '">' + esc(opt.label) + '</span>';
      }
      html += '        </div>';
    }

    // Answer
    html += '        <div class="relative pl-10">';
    html += '          <div class="absolute left-0 top-0 select-none" style="color: var(--primary); opacity: 0.2;">';
    html += '            <span class="font-serif text-4xl leading-none">A</span>';
    html += '          </div>';
    html += '          <div class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[10px] font-mono uppercase tracking-wider font-bold mb-2" style="background: color-mix(in srgb, var(--primary) 15%, transparent); color: var(--primary);">You Answered</div>';
    html += '          <p class="font-serif text-base leading-relaxed" style="color: var(--text-primary);">' + esc(answerText) + '</p>';
    html += '        </div>';

    html += '      </div>';
  }

  // Copy JSON action
  const copyId = 'qa-' + Math.random().toString(36).slice(2, 10);
  qaRegistry[copyId] = { questions: pair.questions, answers: pair.answers };
  html += '      <div class="px-6 py-2 border-t flex items-center gap-4" style="border-color: var(--border); background: var(--bg-surface);">';
  html += '        <button onclick="copyQAJSON(\\'' + copyId + '\\')" class="flex items-center gap-1.5 text-xs font-sans font-medium transition-colors" style="color: var(--text-secondary);">';
  html += '          <span class="material-symbols-outlined" style="font-size: 16px;">content_copy</span>';
  html += '          Copy JSON';
  html += '        </button>';
  html += '      </div>';

  html += '    </div>';
  html += '  </div>';
  html += '</div>';

  return html;
}

function renderTimelineEntry(entry) {
  let html = '';
  const time = formatTime(entry.timestamp);
  const TRUNCATE_THRESHOLD = 200;

  // ── Tier 2: Conversation entries (user + claude messages) ──
  if (entry.type === 'user_text' || entry.type === 'assistant_text') {
    const isUser = entry.type === 'user_text';
    const label = isUser ? 'You' : 'Claude';
    const color = isUser ? '#3B82F6' : '#8B5CF6';
    const contentText = entry.content || '';
    const needsTruncation = contentText.length > TRUNCATE_THRESHOLD;
    const entryId = 'conv-' + Math.random().toString(36).slice(2, 8);

    html += '<div class="conv-entry my-2 px-4 py-3">';
    html += '  <div class="flex items-center gap-2 mb-1.5">';
    html += '    <div class="w-2 h-2 rounded-full flex-shrink-0" style="background: ' + color + ';"></div>';
    html += '    <span class="text-xs font-sans font-semibold" style="color: ' + color + ';">' + label + '</span>';
    html += '    <span class="text-[11px] font-mono" style="color: var(--text-muted);">' + time + '</span>';
    html += '  </div>';
    html += '  <div id="' + entryId + '" class="conv-body pl-4 ml-0.5 border-l" style="border-color: color-mix(in srgb, ' + color + ' 20%, transparent);' + (needsTruncation ? '' : '') + '"' + (needsTruncation ? ' data-truncated="true"' : '') + '>';
    html += '    <p class="text-sm font-serif leading-relaxed whitespace-pre-line" style="color: var(--text-secondary);">' + esc(contentText) + '</p>';
    html += '  </div>';
    if (needsTruncation) {
      html += '  <button onclick="toggleConvExpand(\\'' + entryId + '\\', this)" class="conv-expand-btn flex items-center gap-1 mt-1.5 pl-5 text-xs font-sans">';
      html += '    <span class="material-symbols-outlined" style="font-size: 14px;">expand_more</span>';
      html += '    Show more';
      html += '  </button>';
    }
    html += '</div>';
    return html;
  }

  // ── Tier 3: Tool calls (compact pills) ──
  if (entry.type === 'tool_use') {
    html += '<div class="tool-pill flex items-center gap-3 py-1 px-4 rounded-sm">';
    html += '  <span class="text-[10px] font-mono" style="color: var(--text-muted);">' + time + '</span>';
    html += '  <div class="w-1.5 h-1.5 rounded-full flex-shrink-0" style="background: var(--primary); opacity: 0.6;"></div>';
    html += '  <span class="text-[11px] font-mono truncate" style="color: var(--text-muted);">';
    html += '    <span style="color: var(--primary); opacity: 0.8; font-weight: 600;">' + esc(entry.toolName) + '</span>';
    if (entry.content) {
      html += ' · ' + esc(entry.content?.slice(0, 80));
    }
    html += '  </span>';
    html += '</div>';
    return html;
  }

  // ── Tool results: skip (noise) ──
  return html;
}

// ─── Interactions ─────────────────────────────────────────────────────────
function setFilter(mode) {
  currentFilter = mode;
  document.getElementById('filter-all').classList.toggle('active', mode === 'all');
  document.getElementById('filter-qa').classList.toggle('active', mode === 'qa');

  const detail = document.getElementById('session-detail');
  const session = detail._session;
  const qaByToolUseId = detail._qaByToolUseId;
  const answerByToolUseId = detail._answerByToolUseId;

  const timelineEl = document.getElementById('timeline-content');
  if (timelineEl && session) {
    timelineEl.innerHTML = renderTimeline(session, qaByToolUseId, answerByToolUseId);
    applyTruncation();
  }
}

function toggleConvExpand(entryId, btn) {
  const el = document.getElementById(entryId);
  if (!el) return;
  const isTruncated = el.dataset.truncated === 'true';
  if (isTruncated) {
    el.classList.remove('truncated');
    el.classList.add('expanded');
    el.dataset.truncated = 'false';
    btn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 14px;">expand_less</span> Show less';
  } else {
    el.classList.remove('expanded');
    el.classList.add('truncated');
    el.dataset.truncated = 'true';
    btn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 14px;">expand_more</span> Show more';
  }
}

// Apply initial truncation after timeline renders
function applyTruncation() {
  document.querySelectorAll('.conv-body[data-truncated="true"]').forEach(el => {
    el.classList.add('truncated');
  });
}

function copyQAJSON(copyId) {
  const data = qaRegistry[copyId];
  if (!data) return;
  const text = JSON.stringify(data, null, 2);
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.querySelector('button[onclick*="' + copyId + '"]');
    if (btn) {
      const icon = btn.querySelector('.material-symbols-outlined');
      if (icon) {
        icon.textContent = 'check';
        setTimeout(() => { icon.textContent = 'content_copy'; }, 1500);
      }
    }
  }).catch(() => {
    // fallback for non-HTTPS contexts
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  });
}

// ─── Back to Top ──────────────────────────────────────────────────────────
(function() {
  const btn = document.getElementById('back-to-top');
  if (!btn) return;
  window.addEventListener('scroll', function() {
    if (window.scrollY > 300) {
      btn.classList.add('visible');
    } else {
      btn.classList.remove('visible');
    }
  }, { passive: true });
})();

// ─── Init ─────────────────────────────────────────────────────────────────
initRouter();
`;
}

// ─── Server-side HTML Escaping ──────────────────────────────────────────────

function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  console.log('🔍 Discovering Claude Code sessions...');
  const sessionFiles = discoverSessionFiles();
  console.log(`   Found ${sessionFiles.length} session files`);

  if (sessionFiles.length === 0) {
    console.error('No session files found. Is Claude Code installed?');
    process.exit(1);
  }

  console.log('📖 Parsing sessions and extracting Q&A...');
  const allSessions = [];

  for (const fileInfo of sessionFiles) {
    try {
      const parsed = parseJSONLFile(fileInfo.filePath);
      if (parsed.length === 0) continue;

      const meta = extractSessionMeta(parsed, fileInfo);
      const qaPairs = extractQAPairs(parsed);
      const timeline = buildSessionTimeline(parsed);

      allSessions.push({ meta, qaPairs, timeline });
    } catch (e) {
      // Skip files that fail to parse
      console.warn(`   Skipped ${fileInfo.sessionId}: ${e.message}`);
    }
  }

  console.log(`   Parsed ${allSessions.length} sessions`);
  const qaCount = allSessions.filter(s => s.qaPairs.length > 0).length;
  const totalQA = allSessions.reduce((sum, s) => sum + s.qaPairs.length, 0);
  console.log(`   Found ${qaCount} sessions with ${totalQA} total Q&A interactions`);

  const viewModel = buildViewModel(allSessions);
  console.log('\n📝 Generating HTML...');
  const html = generateHTML(viewModel);

  fs.writeFileSync(OUTPUT_PATH, html, 'utf-8');
  console.log(`   Written to ${OUTPUT_PATH}`);

  console.log('🌐 Opening in browser...');
  try {
    execSync(`${OPEN_CMD} "${OUTPUT_PATH}"`);
  } catch (e) {
    console.log(`   Could not auto-open. Open manually: ${OUTPUT_PATH}`);
  }

  console.log('✅ Done!');
}

main();
