const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { StorageEngine } = require('../dist/main/storage.js');

test('Daily Token Activity & Heatmap Aggregation', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-lens-activity-test-'));
  const testDb = path.join(tmpDir, 'lens_test.db');
  const storage = new StorageEngine(testDb);

  t.after(() => {
    storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await t.test('returns empty summary when no records exist', () => {
    const summary = storage.getDailyTokenActivity('all');
    assert.equal(summary.total_tokens, 0);
    assert.equal(summary.peak_tokens, 0);
    assert.equal(summary.current_streak, 0);
    assert.equal(summary.longest_streak, 0);
    assert.equal(summary.days.length, 0);
  });

  await t.test('aggregates daily tokens, streaks, and respects agent filter', () => {
    // 插入测试记录
    const now = new Date();
    const formatDate = (d) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };

    const todayStr = formatDate(now);
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayStr = formatDate(yesterday);

    // 1. 今天插入两条记录 (Codex: 5000 tokens, Antigravity: 3000 tokens)
    storage.insertRecord({
      session_id: 'sess-today-1',
      agent_name: 'Codex Agent',
      provider: 'openai',
      model: 'gpt-4o',
      method: 'POST',
      url_path: '/v1/chat/completions',
      status_code: 200,
      duration_ms: 1200,
      input_tokens: 4000,
      output_tokens: 1000,
      cached_tokens: 500,
      thinking_tokens: 0,
      total_tokens: 5000,
      cache_ratio: 12.5,
      system_prompt: '',
      prompt_summary: 'Today Task 1',
      user_prompt: 'Fix this code',
      response_preview: 'OK',
      request_headers: {},
      request_body: '',
      response_body: '',
      raw_usage: {}
    });

    storage.insertRecord({
      session_id: 'sess-today-2',
      agent_name: 'Antigravity',
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      method: 'POST',
      url_path: '/v1/chat/completions',
      status_code: 200,
      duration_ms: 3500,
      input_tokens: 2000,
      output_tokens: 1000,
      cached_tokens: 0,
      thinking_tokens: 200,
      total_tokens: 3000,
      cache_ratio: 0,
      system_prompt: '',
      prompt_summary: 'Today Task 2',
      user_prompt: 'Refactor UI',
      response_preview: 'Done',
      request_headers: {},
      request_body: '',
      response_body: '',
      raw_usage: {}
    });

    // 2. 检查全量统计 (all)
    const allSummary = storage.getDailyTokenActivity('all');
    assert.equal(allSummary.total_tokens, 8000);
    assert.equal(allSummary.peak_tokens, 8000);
    assert.equal(allSummary.peak_date, todayStr);
    assert.equal(allSummary.max_duration_ms, 3500);
    assert.equal(allSummary.current_streak, 1);
    assert.equal(allSummary.days.length, 1);
    assert.equal(allSummary.days[0].date, todayStr);
    assert.equal(allSummary.days[0].total_tokens, 8000);

    // 3. 检查 Codex 过滤
    const codexSummary = storage.getDailyTokenActivity('Codex');
    assert.equal(codexSummary.total_tokens, 5000);
    assert.equal(codexSummary.peak_tokens, 5000);
    assert.equal(codexSummary.days.length, 1);
    assert.equal(codexSummary.days[0].total_tokens, 5000);

    // 4. 检查 Antigravity 过滤
    const antiSummary = storage.getDailyTokenActivity('Antigravity');
    assert.equal(antiSummary.total_tokens, 3000);
    assert.equal(antiSummary.peak_tokens, 3000);
    assert.equal(antiSummary.days.length, 1);
    assert.equal(antiSummary.days[0].total_tokens, 3000);

    // 5. 检查 agent_breakdown
    assert.equal(allSummary.days[0].agent_breakdown.Codex, 5000);
    assert.equal(allSummary.days[0].agent_breakdown.Antigravity, 3000);

    // 6. 检查各模型消耗统计 (全量与按 Agent 过滤)
    const modelUsages = storage.getDayModelUsage(todayStr, 'all');
    assert.equal(modelUsages.length, 2);
    assert.equal(modelUsages[0].model, 'gpt-4o');
    assert.equal(modelUsages[0].total_tokens, 5000);
    assert.equal(modelUsages[1].model, 'gemini-2.5-pro');
    assert.equal(modelUsages[1].total_tokens, 3000);

    const codexModels = storage.getDayModelUsage(todayStr, 'Codex');
    assert.equal(codexModels.length, 1);
    assert.equal(codexModels[0].model, 'gpt-4o');
    assert.equal(codexModels[0].total_tokens, 5000);

    const antiModels = storage.getDayModelUsage(todayStr, 'Antigravity');
    assert.equal(antiModels.length, 1);
    assert.equal(antiModels[0].model, 'gemini-2.5-pro');
    assert.equal(antiModels[0].total_tokens, 3000);

    const piModels = storage.getDayModelUsage(todayStr, 'Pi');
    assert.equal(piModels.length, 0);

    // 7. 检查当天任务明细
    const details = storage.getDayTokenDetails(todayStr, 'all');
    assert.equal(details.length, 2);
    assert.equal(details[0].total_tokens, 5000);
    assert.equal(details[1].total_tokens, 3000);
  });
});

test('Agent category filters use the same strict classification as the renderer', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-lens-agent-category-'));
  const storage = new StorageEngine(path.join(tmpDir, 'lens_test.db'));
  try {
    const now = new Date().toISOString();
    storage.insertRecord({ agent_name: 'Copilot', provider: 'openai', model: 'copilot-model', created_at: now, total_tokens: 100, input_tokens: 100, user_prompt: 'other' });
    storage.insertRecord({ agent_name: 'Pi Agent', provider: 'openai', model: 'pi-model', created_at: now, total_tokens: 200, input_tokens: 200, user_prompt: 'pi' });
    const date = storage.db.prepare("SELECT date('now', 'localtime') AS day").get().day;
    assert.equal(storage.getDailyTokenActivity('Pi').total_tokens, 200);
    assert.equal(storage.getDailyTokenActivity('Other').total_tokens, 100);
    assert.deepEqual(storage.getDayModelUsage(date, 'Pi').map((row) => row.model), ['pi-model']);
    assert.deepEqual(storage.getDayTokenDetails(date, 'Other').map((row) => row.agent_name), ['Copilot']);
  } finally {
    storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
