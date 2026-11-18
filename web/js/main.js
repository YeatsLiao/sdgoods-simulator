import { App } from "./app/app.js";

const root = document.querySelector("#app") ?? document.body;
const app = new App(root);
window.__sdgSimulator = app;
app.init().catch((error) => {
  console.error(error);
  const status = document.querySelector("#status");
  if (status) status.textContent = error.message || "页面初始化失败";
});
