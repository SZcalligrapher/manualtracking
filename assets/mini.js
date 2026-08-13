import { createEditor } from "./app.js?v=20260810-26";

const editor = createEditor({ mode: "mini" });
document.querySelector("#demoButton").addEventListener("click", editor.loadDemo);
document.querySelector("#saveLocalButton").addEventListener("click", () => {
  localStorage.setItem("manual-tracking-project", JSON.stringify(editor.serializeProject()));
  editor.showToast("进度已保存在本机");
});

const saved = localStorage.getItem("manual-tracking-project");
if (saved) {
  try { editor.loadTracking(JSON.parse(saved)); }
  catch (_) { editor.loadDemo(); }
} else {
  editor.loadDemo();
}
