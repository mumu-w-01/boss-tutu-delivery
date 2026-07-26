let latestDiagnostic = "";

async function diagnoseCurrentPage() {
  const panel = document.getElementById("diagnosticPanel");
  const summary = document.getElementById("diagnosticSummary");
  const output = document.getElementById("diagnosticOutput");
  try {
    const tab = await activeTab();
    const url = new URL(tab?.url || "https://invalid.local");
    if (!/(^|\.)zhipin\.com$/.test(url.hostname)) throw new Error(`当前检测到的不是 BOSS 职位页：${url.hostname || "未知页面"}`);
    const response = await messagePage(tab, { type: "DIAGNOSE_PAGE" });
    if (!response?.ok) throw new Error(response?.error || "页面诊断失败");
    latestDiagnostic = JSON.stringify(response.data, null, 2);
    summary.textContent = response.data.diagnosis;
    output.textContent = latestDiagnostic;
    panel.classList.remove("hidden");
    toast("诊断完成，可复制信息发给我");
  } catch (error) {
    latestDiagnostic = JSON.stringify({ checkedAt: new Date().toISOString(), error: error.message }, null, 2);
    summary.textContent = "未能连接页面，复制下方信息发给我。";
    output.textContent = latestDiagnostic;
    panel.classList.remove("hidden");
    toast(error.message);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("diagnose").onclick = diagnoseCurrentPage;
  document.getElementById("copyDiagnostic").onclick = async () => {
    if (!latestDiagnostic) return toast("请先运行页面诊断");
    await navigator.clipboard.writeText(latestDiagnostic);
    toast("诊断信息已复制");
  };
});
