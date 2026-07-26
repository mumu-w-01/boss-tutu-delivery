const DEFAULTS = {
  endpoint: "https://api.openai.com/v1",
  model: "gpt-4.1-mini",
  apiKey: "",
  candidateProfile: "",
  greetingPrompt: "",
  resumeImages: []
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  chrome.storage.local.get("config", ({ config }) => {
    if (!config) chrome.storage.local.set({ config: DEFAULTS, jobLibrary: [] });
  });
});

function endpointUrl(endpoint) {
  const base = String(endpoint || "").trim().replace(/\/$/, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

async function callAI({ config, messages, maxTokens = 1800, jsonMode = false }) {
  const url = endpointUrl(config.endpoint);
  const origin = new URL(url).origin + "/*";
  const granted = await chrome.permissions.contains({ origins: [origin] });
  if (!granted) throw new Error("请先在设置中允许此 AI 服务的网址访问权限。");
  let response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const useJsonMode = jsonMode && (/deepseek/i.test(config.endpoint || "") || /deepseek/i.test(config.model || ""));
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.model, messages, temperature: 0.35, max_tokens: maxTokens, ...(useJsonMode ? { response_format: { type: "json_object" } } : {}) }),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`AI 服务连接超时（20 秒）：${url}。请检查 API 地址、网络或服务状态。`);
    throw new Error(`无法连接 AI 服务：${url}。请检查 API 地址、网络，并在「设置」点击“测试连接”授权该服务。`);
  } finally {
    clearTimeout(timeout);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `AI 服务返回 ${response.status}`);
  const content = body?.choices?.[0]?.message?.content;
  const text = Array.isArray(content) ? content.map(part => part?.text || "").join("") : content;
  if (!text) throw new Error("AI 服务没有返回内容。");
  return text;
}

function jsonFrom(text) {
  // DeepSeek Flash 等文本模型可能在 JSON 前后返回说明或思考内容；只提取首个完整 JSON 对象。
  const raw = String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const candidates = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match => match[1].trim());
  candidates.push(raw);
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch (_) {}
    const start = candidate.indexOf("{");
    if (start < 0) continue;
    let depth = 0; let quoted = false; let escaped = false;
    for (let index = start; index < candidate.length; index++) {
      const char = candidate[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') { quoted = true; continue; }
      if (char === "{") depth++;
      if (char === "}" && --depth === 0) {
        try { return JSON.parse(candidate.slice(start, index + 1)); } catch (_) { break; }
      }
    }
  }
  throw new Error("AI 返回的内容不是可读取的 JSON。请确认模型支持文本对话，并重试。");
}

function jobIdentityKeys(job) {
  const keys = new Set();
  const add = (value) => {
    const text = String(value || "").trim();
    if (!text) return;
    keys.add(text);
    try {
      const url = new URL(text);
      keys.add(`${url.origin}${url.pathname}`);
      const match = url.pathname.match(/\/job_detail\/([^./?]+)(?:\.html)?/);
      if (match) keys.add(`jobId:${match[1]}`);
    } catch (_) {}
  };
  if (job?.jobId) add(`jobId:${job.jobId}`);
  add(job?.key);
  add(job?.detailUrl);
  // 职位列表页的 url 对所有岗位都相同，只有缺少具体 jobId/detailUrl 时才作为兜底。
  if (!job?.jobId && !job?.detailUrl && !job?.key) add(job?.url);
  const fallback = [job?.company, job?.title, job?.location].map(value => String(value || "").trim()).join("|");
  if (fallback !== "||") keys.add(`fallback:${fallback}`);
  return [...keys];
}

function sameJob(first, second) {
  const secondKeys = new Set(jobIdentityKeys(second));
  return jobIdentityKeys(first).some(key => secondKeys.has(key));
}

function dedupeJobLibrary(jobLibrary) {
  const unique = [];
  for (const job of Array.isArray(jobLibrary) ? jobLibrary : []) {
    if (!unique.some(existing => sameJob(existing, job))) unique.push(job);
  }
  return unique;
}

async function getJobLibrary() {
  const { jobLibrary = [] } = await chrome.storage.local.get("jobLibrary");
  const unique = dedupeJobLibrary(jobLibrary);
  if (unique.length !== jobLibrary.length) await chrome.storage.local.set({ jobLibrary: unique });
  return unique;
}

async function saveJob(job) {
  const jobLibrary = await getJobLibrary();
  // 职位列表页的 URL 对所有卡片相同，不能作为唯一键；优先使用当前岗位的详情链接。
  const key = job.detailUrl || job.url || `${job.company}|${job.title}|${job.location}`;
  const existing = jobLibrary.findIndex((item) => sameJob(item, job));
  const record = { ...job, key, updatedAt: new Date().toISOString() };
  if (existing >= 0) jobLibrary[existing] = { ...jobLibrary[existing], ...record };
  else jobLibrary.unshift(record);
  await chrome.storage.local.set({ jobLibrary });
  return record;
}

function escapeCsv(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

async function exportJobs() {
  const jobLibrary = await getJobLibrary();
  const columns = [
    ["投递时间", "sentAt"], ["岗位名称", "title"], ["公司", "company"], ["地点", "location"],
    ["薪资", "salary"], ["完整JD", "description"], ["打招呼语", "greeting"],
    ["投递状态", "status"], ["岗位链接", "url"]
  ];
  const csv = "\uFEFF" + [columns.map(([label]) => escapeCsv(label)).join(","), ...jobLibrary.map(job => columns.map(([, key]) => escapeCsv(key === "url" ? (job.detailUrl || job.url) : job[key])).join(","))].join("\r\n");
  const url = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
  await chrome.downloads.download({ url, filename: `兔兔投递-岗位库-${new Date().toISOString().slice(0, 10)}.csv`, saveAs: true });
}

let queueRunning = false;
let queueBatch = { current: 0, total: 0 };
let workerTabId = null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getQueue() {
  const { deliveryQueue = [] } = await chrome.storage.local.get("deliveryQueue");
  // 成功岗位已写入岗位库，不应继续占用待投递清单；同时清理旧版本遗留的成功记录。
  const activeQueue = deliveryQueue.filter(item => item.status !== "已成功");
  if (activeQueue.length !== deliveryQueue.length) await chrome.storage.local.set({ deliveryQueue: activeQueue });
  return activeQueue;
}

async function setQueue(queue) {
  await chrome.storage.local.set({ deliveryQueue: queue });
}

async function queueJob(job) {
  const queue = await getQueue();
  const key = job.jobId || job.detailUrl;
  if (!key) throw new Error("未读取到岗位唯一标识，请在岗位页重新分析后再加入清单。");
  if (queue.some(item => item.key === key)) throw new Error("该岗位已在投递清单中。");
  if (queue.filter(item => item.status !== "已成功").length >= 20) throw new Error("投递清单最多保留 20 条待处理岗位。");
  const item = { ...job, key, greeting: job.greeting || "", status: job.greeting ? "待投递" : "待生成", queuedAt: new Date().toLocaleString("zh-CN"), error: "" };
  queue.unshift(item); await setQueue(queue); return item;
}

async function updateQueueItem(key, patch) {
  const queue = await getQueue();
  const index = queue.findIndex(item => item.key === key);
  if (index >= 0) queue[index] = { ...queue[index], ...patch, updatedAt: new Date().toISOString() };
  await setQueue(queue);
  return queue[index];
}

async function removeQueueItem(key) {
  const queue = await getQueue();
  const next = queue.filter(item => item.key !== key);
  await setQueue(next);
  return next.length !== queue.length;
}

async function removeQueueItems(keys) {
  const requestedKeys = [...new Set((Array.isArray(keys) ? keys : []).filter(Boolean))];
  const queue = await getQueue();
  const keySet = new Set(requestedKeys);
  const next = queue.filter(item => !keySet.has(item.key));
  const removedCount = queue.length - next.length;
  if (removedCount > 0) await setQueue(next);
  return {
    removedCount,
    requestedCount: requestedKeys.length,
    missingKeys: requestedKeys.filter(key => !queue.some(item => item.key === key)),
  };
}

async function sendToTab(tabId, message) {
  try { return await chrome.tabs.sendMessage(tabId, message); }
  catch (error) {
    if (!/Receiving end does not exist/i.test(error.message || "")) throw error;
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function waitForTab(tabId, fragment, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete" && tab.url?.includes(fragment)) return tab;
    await sleep(300);
  }
  throw new Error(`页面加载超时：${fragment}`);
}

async function ensureWorker(url) {
  try {
    if (workerTabId) await chrome.tabs.get(workerTabId);
  } catch (_) { workerTabId = null; }
  if (!workerTabId) workerTabId = (await chrome.tabs.create({ url, active: false })).id;
  else await chrome.tabs.update(workerTabId, { url, active: false });
  return workerTabId;
}

async function runQueue() {
  if (queueRunning) throw new Error("投递清单正在执行中。");
  queueRunning = true;
  try {
    const items = (await getQueue()).filter(item => ["待投递", "待确认"].includes(item.status)).slice(0, 20);
    if (!items.length) throw new Error("没有待投递岗位。");
    queueBatch = { current: 0, total: items.length };
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      queueBatch.current = index + 1;
      await updateQueueItem(item.key, { status: "投递中", progress: `正在投递第 ${queueBatch.current}/${queueBatch.total} 个岗位：打开岗位详情`, error: "" });
      try {
        if (!item.detailUrl) throw new Error("缺少岗位详情链接");
        const tabId = await ensureWorker(item.detailUrl);
        await waitForTab(tabId, "/job_detail/");
        await updateQueueItem(item.key, { progress: "正在核验岗位信息" });
        const verify = await sendToTab(tabId, { type: "VERIFY_JOB", job: item });
        if (!verify?.ok) throw new Error(`岗位核验失败：${verify?.reason || "信息不一致"}`);
        await updateQueueItem(item.key, { progress: "正在打开 BOSS 沟通页" });
        const open = await sendToTab(tabId, { type: "OPEN_COMMUNICATION" });
        if (!open?.ok) throw new Error(open?.error || "无法打开沟通页");
        try { await waitForTab(tabId, "/web/geek/chat"); }
        catch (_) {
          // BOSS 偶发“会话已建但页面没有跳转”。参考 jitou 的补救策略，再点一次继续沟通后重等一次。
          await updateQueueItem(item.key, { progress: "沟通页未跳转，正在重试" });
          const retryOpen = await sendToTab(tabId, { type: "OPEN_COMMUNICATION" });
          if (!retryOpen?.ok) throw new Error(retryOpen?.error || "沟通页未跳转，重试点击失败");
          await waitForTab(tabId, "/web/geek/chat");
        }
        await updateQueueItem(item.key, { progress: "正在发送招呼语和简历图片" });
        const sent = await sendToTab(tabId, { type: "SEND_MESSAGE", greeting: item.greeting, images: (await chrome.storage.local.get("config")).config?.resumeImages || [] });
        if (!sent?.ok) throw new Error(sent?.error || "发送失败");
        await saveJob({ ...item, status: "已沟通", sentAt: new Date().toLocaleString("zh-CN"), resumeStatus: sent.resume?.sent ? "简历图片已确认送达" : (sent.resume?.reason || "未发送") });
        // 岗位库已保存成功记录，待投递清单实时移除，避免和历史记录重复出现。
        await removeQueueItem(item.key);
      } catch (error) {
        await updateQueueItem(item.key, { status: "失败", progress: "", error: error.message || String(error) });
      }
    }
  } finally {
    queueRunning = false;
    queueBatch = { current: 0, total: 0 };
    try { if (workerTabId) await chrome.tabs.remove(workerTabId); } catch (_) {}
    workerTabId = null;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.type === "AI_CALL") {
      const text = await callAI(message.payload);
      sendResponse({ ok: true, text });
    } else if (message.type === "PARSE_JSON") {
      sendResponse({ ok: true, data: jsonFrom(message.text) });
    } else if (message.type === "SAVE_JOB") {
      sendResponse({ ok: true, job: await saveJob(message.job) });
    } else if (message.type === "LIBRARY_GET") {
      sendResponse({ ok: true, jobLibrary: await getJobLibrary() });
    } else if (message.type === "EXPORT_JOBS") {
      await exportJobs(); sendResponse({ ok: true });
    } else if (message.type === "QUEUE_ADD") {
      sendResponse({ ok: true, item: await queueJob(message.job) });
    } else if (message.type === "QUEUE_GET") {
      sendResponse({ ok: true, queue: await getQueue(), running: queueRunning, batch: queueBatch });
    } else if (message.type === "QUEUE_UPDATE") {
      sendResponse({ ok: true, item: await updateQueueItem(message.key, message.patch || {}) });
    } else if (message.type === "QUEUE_REMOVE") {
      sendResponse({ ok: await removeQueueItem(message.key) });
    } else if (message.type === "QUEUE_REMOVE_MANY") {
      const result = await removeQueueItems(message.keys);
      sendResponse({ ok: result.removedCount === result.requestedCount, ...result });
    } else if (message.type === "QUEUE_START") {
      if (queueRunning) { sendResponse({ ok: true, alreadyRunning: true }); return; }
      const count = (await getQueue()).filter(item => ["待投递", "待确认"].includes(item.status)).slice(0, 20).length;
      if (!count) throw new Error("没有已生成招呼语的岗位。");
      runQueue().catch(() => {}); sendResponse({ ok: true, count });
    }
  })().catch(error => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});
