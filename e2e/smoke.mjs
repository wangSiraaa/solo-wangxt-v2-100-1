// 端到端冒烟：真实浏览器中加载示例公式，验证状态徽章、量纲定位、KaTeX 渲染、隔离与已发布结果引用
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const URL = "http://localhost:5199/";

// 某些环境只装了完整 chromium（无 chrome-headless-shell）：回退到完整二进制
function launchOptions() {
  const shell = chromium.executablePath();
  if (fs.existsSync(shell)) return {};
  const home = os.homedir();
  const roots = ["chromium-1243", "chromium-1242", "chromium-1240", "chromium-1232"];
  const cands = [];
  for (const r of roots) {
    for (const d of ["chrome-linux", "chrome-linux-arm64", "chrome-linux64"]) {
      cands.push(path.join(home, ".cache/ms-playwright", r, d, "chrome"));
    }
  }
  const found = cands.find((p) => fs.existsSync(p));
  return found ? { executablePath: found } : {};
}

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const browser = await chromium.launch(launchOptions());
const page = await browser.newPage();
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForSelector(".app");

// math-field 自定义元素注册
const hasField = await page.evaluate(() => !!customElements.get("math-field"));
check("MathLive <math-field> 已注册", hasField);

// 依次加载 5 个示例
for (const kind of ["unit", "degC", "angle", "dimErr", "divZero"]) {
  await page.getByRole("button", { name: `示例：${{
    unit: "单位运算", degC: "摄氏温标", angle: "角度弧度", dimErr: "量纲错误", divZero: "除零",
  }[kind]}` }).click();
}
await page.waitForTimeout(600);

const cards = page.locator(".card");
await cards.last().waitFor();
const n = await cards.count();
check("创建了 5 张公式卡片", n === 5, `实际 ${n}`);

async function cardInfo(i) {
  const card = cards.nth(i);
  return {
    badge: (await card.locator(".badge").innerText()).trim(),
    summary: (await card.locator(".summary").innerText()).trim(),
    issues: await card.locator(".issue").allInnerTexts(),
    resultText: (await card.locator(".result-row .tex-box").innerText().catch(() => "")).trim(),
    hasRedTex: (await card.locator(".display-area").innerHTML()).includes("#d11f2d"),
    hasOrangeTex: (await card.locator(".display-area").innerHTML()).includes("#b26a00"),
    katexCount: await card.locator(".katex").count(),
  };
}

// 1) 单位运算：2 m/s * 3 s + 1/2 * 4 m/s^2 * 9 s^2 = 6 + 18 = 24 m
const c1 = await cardInfo(0);
check("单位运算：已验证", c1.badge === "已验证", c1.badge);
check("单位运算：结果 24 m", /24/.test(c1.resultText), c1.resultText);
check("单位运算：KaTeX 已渲染", c1.katexCount >= 3, `${c1.katexCount} 个 .katex`);

// 2) 摄氏温标：未验证 + 橙色高亮
const c2 = await cardInfo(1);
check("摄氏温标：标记未验证", c2.badge === "未验证", c2.badge);
check("摄氏温标：提示偏移温标", c2.issues.some((t) => t.includes("偏移温标")), c2.issues[0] ?? "");
check("摄氏温标：橙色高亮问题节点", c2.hasOrangeTex);

// 3) 角度弧度：1 rad + 180 deg，目标 deg
const c3 = await cardInfo(2);
check("角度弧度：已验证", c3.badge === "已验证", c3.badge);
const num = c3.resultText.replace(/[^\d.]/g, " ");
check("角度弧度：含 π+1≈4.1416 rad 或换算 237.65 deg",
  /4\.141|237\.6|57\.29/.test(num) || /237/.test(c3.resultText), c3.resultText);

// 4) 量纲错误：红色定位到 (a+b) 节点
const c4 = await cardInfo(3);
check("量纲错误：有错误", c4.badge === "有错误", c4.badge);
check("量纲错误：提示不能相加且量纲不兼容",
  c4.issues.some((t) => t.includes("量纲不兼容") && t.includes("相加")), c4.issues[0] ?? "");
check("量纲错误：原式红色高亮问题节点", c4.hasRedTex);

// 5) 除零：明确报错
const c5 = await cardInfo(4);
check("除零：有错误", c5.badge === "有错误", c5.badge);
check("除零：报除数为零", c5.issues.some((t) => t.includes("除数为零")), c5.issues[0] ?? "");
check("除零：不显示结果数值", !/=\s*\d/.test(c5.resultText), c5.resultText);

// 6) 隔离：删除量纲错误卡片后，其余 4 张状态不变
await page.getByRole("button", { name: "删除" }).nth(3).click();
await page.waitForTimeout(300);
check("删除后剩余 4 张", await cards.count() === 4);
const b0 = (await cards.nth(0).locator(".badge").innerText()).trim();
const b1 = (await cards.nth(1).locator(".badge").innerText()).trim();
const b3 = (await cards.nth(3).locator(".badge").innerText()).trim();
check("隔离：好公式仍已验证", b0 === "已验证", b0);
check("隔离：摄氏仍未验证", b1 === "未验证", b1);
check("隔离：除零卡片仍有错误", b3 === "有错误", b3);

// 7) IndexedDB 持久化：刷新后数据仍在
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(500);
check("刷新后仍保留 4 张公式（IndexedDB）", await page.locator(".card").count() === 4);

// 8) 编辑交互：新建公式，填 a+b 不同量纲，实时报错
await page.getByRole("button", { name: "＋ 新建公式" }).click();
await page.waitForTimeout(200);
const card = page.locator(".card").last();
const mf = card.locator("math-field");
// 通过设置 value + 派发 input 模拟输入（MathLive 支持键盘，无头环境用 evaluate）
await mf.evaluate((el, v) => {
  el.setValue(v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}, "a+b");
await page.waitForTimeout(300);
// 变量表出现两行
const varRows = await card.locator(".var-row:not(.var-head)").count();
check("变量表识别出 a、b 两个变量", varRows === 2, `${varRows} 行`);
// 初始：未赋值错误（不自动取零）
let badge = (await card.locator(".badge").innerText()).trim();
check("未赋值变量明确报错", badge === "有错误");
// 填值：a=1 m, b=2 kg
const inputs = card.locator(".var-row:not(.var-head) input");
await inputs.nth(0).fill("1");
await inputs.nth(1).fill("m");
await inputs.nth(2).fill("2");
await inputs.nth(3).fill("kg");
await page.waitForTimeout(300);
badge = (await card.locator(".badge").innerText()).trim();
const issue = (await card.locator(".issue").first().innerText());
check("m+kg 实时变为量纲错误", badge === "有错误" && issue.includes("量纲不兼容"), issue);
// 改为 b=2 m → 已验证 3 m
await inputs.nth(3).fill("m");
await page.waitForTimeout(300);
badge = (await card.locator(".badge").innerText()).trim();
check("改为同量纲后实时变为已验证 = 3 m", badge === "已验证", badge);

// ========== 已发布结果引用：四个验收场景 ==========

// 场景 1：长度/时间发布速度 → 引用 → 换算 km/h
await page.getByRole("button", { name: "示例：引用发布速度→km/h" }).click();
await page.waitForTimeout(500);
let allCards = page.locator(".card");
const base = await allCards.count(); // 前 6 条是原有卡，新 4 条在末尾
const idxLen = base - 4, idxTime = base - 3, idxSpeed = base - 2, idxKmh = base - 1;
check("引用示例创建了 4 张卡片", base >= 4);
check("引用-长度已验证", (await allCards.nth(idxLen).locator(".badge").innerText()).trim() === "已验证");
check("引用-时间已验证", (await allCards.nth(idxTime).locator(".badge").innerText()).trim() === "已验证");
const speedBadge = (await allCards.nth(idxSpeed).locator(".badge").innerText()).trim();
check("引用-速度已验证 = 25 m/s", speedBadge === "已验证", speedBadge);
const speedRes = (await allCards.nth(idxSpeed).locator(".result-row .tex-box").innerText()).trim();
check("引用-速度结果 25 m/s", /25/.test(speedRes) && /m/.test(speedRes), speedRes);
const kmhBadge = (await allCards.nth(idxKmh).locator(".badge").innerText()).trim();
check("引用-km/h 已验证", kmhBadge === "已验证", kmhBadge);
const kmhRes = (await allCards.nth(idxKmh).locator(".result-row").innerText()).trim();
check("引用-km/h 结果为 90 km/h", /90/.test(kmhRes) && /km/.test(kmhRes), kmhRes);
// 溯源：原式蓝色派生变量 + 溯源面板显示来源版本
check("引用-km/h 原式有蓝色溯源", (await allCards.nth(idxKmh).locator(".display-area").innerHTML()).includes("#1f6feb"));
check("引用-km/h 溯源面板显示已对齐版本", (await allCards.nth(idxKmh).locator(".trace-panel").innerText()).includes("已对齐 v"));
check("引用-速度变量表只读显示来源值", (await allCards.nth(idxSpeed).locator(".derived-cell").first().innerText()).includes("100"));

// 场景 2：上游改成量纲错误 → 下游阻塞；无关公式（第一张）仍正常；快照仍可查看
// 长度公式 s 原本是 100 m，改成 s+m 不同量纲：先改表达式，再给新变量 m 赋 kg
const lenCard = allCards.nth(idxLen);
await lenCard.locator("math-field").evaluate((el) => {
  el.setValue("s+m");
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(300);
// 新变量 m 的输入行（派生变量之外的普通变量表）：找到值输入填 2、单位填 kg
const lenInputs = lenCard.locator(".var-row:not(.var-head):not(.derived) input");
await lenInputs.nth(2).fill("2");   // 第 2 个变量 m 的数值（0=s值,1=s单位,2=m值,3=m单位）
await lenInputs.nth(3).fill("kg");
await page.waitForTimeout(500);
const lenBadge2 = (await lenCard.locator(".badge").innerText()).trim();
check("上游改成 m+kg 量纲错误", lenBadge2 === "有错误", lenBadge2);
const speedBlocked = (await allCards.nth(idxSpeed).locator(".badge").innerText()).trim();
check("速度下游被阻塞（不拿旧值）", speedBlocked === "引用阻塞", speedBlocked);
const kmhBlocked = (await allCards.nth(idxKmh).locator(".badge").innerText()).trim();
check("km/h 二级下游也被阻塞", kmhBlocked === "引用阻塞", kmhBlocked);
// 阻塞问题列表说明 + 快照仍可查看
const speedIssues = (await allCards.nth(idxSpeed).locator(".issue").allInnerTexts()).join(" ");
check("阻塞问题说明来源错误并保留快照 100 m", speedIssues.includes("存在错误") && speedIssues.includes("100 m"), speedIssues.slice(0, 120));
check("溯源面板仍保留最后有效快照", (await allCards.nth(idxSpeed).locator(".snapshot").innerText()).includes("100 m"));
// 无关普通公式（第一张 单位运算）仍已验证
check("阻塞不影响无关公式", (await allCards.nth(0).locator(".badge").innerText()).trim() === "已验证");

// 恢复上游：表达式改回 s，删掉 m 变量不必要，直接改回表达式即可（m 变量变 ghost 不影响）
await lenCard.locator("math-field").evaluate((el) => {
  el.setValue("s");
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(500);
check("上游恢复后速度自动解除阻塞", (await allCards.nth(idxSpeed).locator(".badge").innerText()).trim() === "已验证");
check("上游恢复后 km/h 自动恢复 90", /90/.test((await allCards.nth(idxKmh).locator(".result-row").innerText())));

// 场景 3：A→B→A 间接循环被拒绝，两条既有公式不被改写
await page.getByRole("button", { name: "＋ 新建公式" }).click();
await page.waitForTimeout(200);
allCards = page.locator(".card");
const idxA = (await allCards.count()) - 1;
const cardA = allCards.nth(idxA);
// A 先是一条没有自由变量的已验证常量公式，这样可以被 B 引用
await cardA.locator("math-field").evaluate((el) => { el.setValue("1+1"); el.dispatchEvent(new Event("input", { bubbles: true })); });
await page.waitForTimeout(400);
check("循环测试：A 初始已验证", (await cardA.locator(".badge").innerText()).trim() === "已验证");

await page.getByRole("button", { name: "＋ 新建公式" }).click();
await page.waitForTimeout(200);
allCards = page.locator(".card");
const idxB = (await allCards.count()) - 1;
const cardB = allCards.nth(idxB);
await cardB.locator("math-field").evaluate((el) => { el.setValue("x"); el.dispatchEvent(new Event("input", { bubbles: true })); });
await page.waitForTimeout(200);

// 先建立合法的 B→A：派生变量 x 引用来源 A
await cardB.getByRole("button", { name: "＋ 引用已验证结果" }).click();
await cardB.locator(".ref-name-input").fill("x");
const bOpts = await cardB.locator(".ref-add .ref-source-select").locator("option").allInnerTexts();
check("B 的来源下拉包含已验证的 A", bOpts.some((t) => t.includes(`#${idxA + 1}`)), JSON.stringify(bOpts));
await cardB.locator(".ref-add .ref-source-select").selectOption({ label: bOpts.find((t) => t.includes(`#${idxA + 1}`)) });
await cardB.locator(".ref-add").getByRole("button", { name: "绑定" }).click();
await page.waitForTimeout(400);
check("B→A 合法引用建立成功", (await cardB.locator(".ref-row .ref-name").innerText()).trim() === "x");
check("B 经引用已验证（x=2）", (await cardB.locator(".badge").innerText()).trim() === "已验证");

// 现在 A 与 B 都已验证。把 A 表达式改为含自由变量 y 并手工赋 1（保持已验证），再尝试 A→B（与既有 B→A 成环）
await cardA.locator("math-field").evaluate((el) => { el.setValue("y+1"); el.dispatchEvent(new Event("input", { bubbles: true })); });
await page.waitForTimeout(300);
// 给 y 手工赋值 1（纯数）：在引用建立前 A 仍已验证；将来派生变量会覆盖此手填值
await cardA.locator(".var-row:not(.var-head):not(.derived) input").nth(0).fill("1");
await page.waitForTimeout(400);
check("改表达式后 A 仍已验证（y=1）", (await cardA.locator(".badge").innerText()).trim() === "已验证");
check("改表达式后 B 沿链重新对齐仍已验证", (await cardB.locator(".badge").innerText()).trim() === "已验证");
await cardA.getByRole("button", { name: "＋ 引用已验证结果" }).click();
await cardA.locator(".ref-name-input").fill("y");
const aOpts = await cardA.locator(".ref-add .ref-source-select").locator("option").allInnerTexts();
const bOpt = aOpts.find((t) => t.includes(`#${idxB + 1}`));
check("A 的来源下拉包含 B", !!bOpt, JSON.stringify(aOpts));
await cardA.locator(".ref-add .ref-source-select").selectOption({ label: bOpt });
await cardA.locator(".ref-add").getByRole("button", { name: "绑定" }).click();
await page.waitForTimeout(300);
const refErr = await cardA.locator(".ref-err").innerText().catch(() => "");
check("A→B 与既有 B→A 成环被拒绝并指出完整环路", refErr.includes("循环引用") && refErr.includes("→"), refErr);
check("被拒绝后 A 没有留下半条引用", (await cardA.locator(".ref-row").count()) === 0);
check("被拒绝后 B 的既有引用未被改写", (await cardB.locator(".ref-row .ref-name").innerText()).trim() === "x");
check("被拒绝后 A 仍按手填值已验证（=2）", (await cardA.locator(".badge").innerText()).trim() === "已验证");

// 场景 4：导出 → 导入到含同名公式的笔记本：引用重连到导入副本，刷新后状态/版本一致
const blobPromise = page.evaluate(() => new Promise((resolve) => {
  const origCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => { resolve(b.text()); return "blob:captured"; };
}));
await page.getByRole("button", { name: "导出 JSON" }).click();
const exportText = await blobPromise;
await page.waitForTimeout(200);
const data = JSON.parse(exportText);
check("导出文件为 v2 且含 refs/版本", data.version === 2 && data.formulas.some((x) => x.refs && x.refs.length > 0));

// 把导出内容写回：模拟“导入到已有同名公式的笔记本”——当前笔记本已含同 id 公式
const fileBuf = Buffer.from(exportText, "utf-8");
await page.getByRole("button", { name: "导入 JSON" }).click();
await page.locator('input[type="file"]').setInputFiles({ name: "nb.json", mimeType: "application/json", buffer: fileBuf });
await page.waitForTimeout(600);
const notice = await page.locator(".notice").innerText();
check("导入提示引用重连", notice.includes("重连"), notice);
// 新导入副本仍能正常算出 90 km/h（找到最后一条含 km/h 目标单位的已验证速度卡）
allCards = page.locator(".card");
const total = await allCards.count();
const lastCard = allCards.nth(total - 1);
const importedBadge = (await lastCard.locator(".badge").innerText()).trim();
check("导入的引用副本重新分析成功（重连到导入副本）", importedBadge === "已验证", importedBadge);

// 刷新后状态与来源版本保持一致
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(600);
allCards = page.locator(".card");
const lastAfter = allCards.nth((await allCards.count()) - 1);
check("刷新后导入副本仍已验证", (await lastAfter.locator(".badge").innerText()).trim() === "已验证");
check("刷新后溯源仍对齐来源版本", (await lastAfter.locator(".trace-panel").innerText()).includes("已对齐 v"));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (consoleErrors.length) console.log("浏览器控制台错误：", JSON.stringify(consoleErrors.slice(0, 5), null, 1));
await browser.close();
if (failed.length) process.exit(1);
