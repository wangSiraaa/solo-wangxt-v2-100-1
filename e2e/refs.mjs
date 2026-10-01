// 端到端：已发布结果引用（速度 km/h、阻塞与快照、间接循环拒绝、导出/导入重连）
// 运行前先启动：npx vite --port 5199
import { chromium } from "playwright";

const URL = "http://localhost:5199/";
const results = [];
function check(name, cond, detail = "") {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForSelector(".app");
// 清空上次残留
await page.evaluate(async () => {
  const dbs = await indexedDB.databases?.() ?? [];
  for (const d of dbs) indexedDB.deleteDatabase(d.name);
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(300);

async function addBlankCard() {
  await page.getByRole("button", { name: "＋ 新建公式" }).click();
  await page.waitForTimeout(150);
  return page.locator(".card").last();
}

async function setLatex(card, tex) {
  await card.locator("math-field").evaluate((el, v) => {
    el.setValue(v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, tex);
  await page.waitForTimeout(150);
}

// 在指定卡片的变量表按行填值：[[value, unit], ...]
async function setVars(card, rows) {
  const inputs = card.locator(".var-row:not(.var-head) input");
  for (let i = 0; i < rows.length; i++) {
    await inputs.nth(i * 2).fill(rows[i][0]);
    await inputs.nth(i * 2 + 1).fill(rows[i][1]);
  }
  await page.waitForTimeout(250);
}

async function setNote(card, note) {
  // 备注是卡片里最后一个无 type 的普通文本 input（变量表、目标单位之后）
  const textInputs = card.locator("input:not([type]), input[type='text']");
  await textInputs.last().fill(note);
  await page.waitForTimeout(100);
}

async function addRef(card, sourceOptionText, alias) {
  await card.locator(".ref-source-select").selectOption({ label: sourceOptionText });
  await card.locator(".ref-alias-input").fill(alias);
  await card.getByRole("button", { name: "建立引用" }).click();
  await page.waitForTimeout(300);
}

// ============================================================
// 场景 1：长度 L=100 m、时间 T=10 s 发布速度 v=10 m/s = 36 km/h
// ============================================================
const cardL = await addBlankCard();
await setLatex(cardL, "x");
await setVars(cardL, [["100", "m"]]);
await setNote(cardL, "长度 L");
check("长度公式已验证", (await cardL.locator(".badge").innerText()) === "已验证", await cardL.locator(".badge").innerText());

const cardT = await addBlankCard();
await setLatex(cardT, "t");
await setVars(cardT, [["10", "s"]]);
await setNote(cardT, "时间 T");
check("时间公式已验证", (await cardT.locator(".badge").innerText()) === "已验证");

const cardV = await addBlankCard();
await setLatex(cardV, "\\dfrac{L_{ref}}{T_{ref}}");
await setNote(cardV, "速度 v");
// 目标单位 km/h
const targetInput = cardV.locator(".unit-result-input");
await targetInput.fill("km/h");
await page.waitForTimeout(150);

const optionsBefore = await cardV.locator(".ref-source-select option").allInnerTexts();
check("来源下拉列出长度与时间两条已验证公式",
  optionsBefore.some((o) => o.includes("长度 L")) && optionsBefore.some((o) => o.includes("时间 T")),
  JSON.stringify(optionsBefore));

await addRef(cardV, /长度 L/, "L_ref");
await addRef(cardV, /时间 T/, "T_ref");
await page.waitForTimeout(300);

const badgeV = await cardV.locator(".badge").innerText();
const resultV = await cardV.locator(".result-row .tex-box").innerText();
check("速度公式引用后已验证", badgeV === "已验证", badgeV);
check("速度 = 10 m/s", /10/.test(resultV) && /m/.test(resultV), resultV);
check("速度换算 = 36 km/h", /36/.test(resultV) && /km/.test(resultV), resultV);
check("引用行显示已连接与来源版本",
  (await cardV.locator(".ref-item.ok").count()) === 2,
  await cardV.locator(".ref-list").innerText());
check("原式中引用符号绿色下划线标注",
  (await cardV.locator(".display-area").innerHTML()).includes("#1a7f37"));
check("问题列表无错误", (await cardV.locator(".issue.error").count()) === 0);

// ============================================================
// 场景 2：上游改成量纲错误 → 下游阻塞；无关公式正常；快照可查看
// ============================================================
const cardI = await addBlankCard();
await setLatex(cardI, "a+b");
await setVars(cardI, [["1", "m"], ["2", "m"]]);
await setNote(cardI, "无关公式");
await page.waitForTimeout(200);
check("无关公式已验证 = 3 m",
  (await cardI.locator(".badge").innerText()) === "已验证" &&
  /3/.test(await cardI.locator(".result-row .tex-box").innerText()));

// 长度公式改成 m + kg（直接改表达式 x → p+q 并改变量）
await setLatex(cardL, "p+q");
// 变量表现在有 p、q 两行，填 1 m、2 kg
await setVars(cardL, [["1", "m"], ["2", "kg"]]);
await page.waitForTimeout(400);

const badgeL = await cardL.locator(".badge").innerText();
check("上游长度公式变为有错误", badgeL === "有错误", badgeL);

const badgeV2 = await cardV.locator(".badge").innerText();
check("速度公式显示引用阻塞", badgeV2 === "引用阻塞", badgeV2);
const blockedText = await cardV.locator(".blocked-banner").innerText();
check("阻塞原因可解释（上游存在错误）", blockedText.includes("上游") && blockedText.includes("错误"), blockedText);
check("阻塞时不显示结果数值", !/=\s*\d/.test(await cardV.locator(".result-row .tex-box").innerText()));
const snapText = await cardV.locator(".snapshot-history, .ref-snapshot").first().innerText().catch(() => "");
check("保留最后有效快照 100 m", snapText.includes("100"), snapText);

const badgeI2 = await cardI.locator(".badge").innerText();
const resI = await cardI.locator(".result-row .tex-box").innerText();
check("无关公式仍正常计算 3 m", badgeI2 === "已验证" && /3/.test(resI), `${badgeI2} ${resI}`);

// 上游修复后下游自动恢复（沿链路重算）
await setLatex(cardL, "x");
await setVars(cardL, [["100", "m"]]);
await page.waitForTimeout(400);
const badgeV3 = await cardV.locator(".badge").innerText();
const resV3 = await cardV.locator(".result-row .tex-box").innerText();
check("上游修复后下游自动恢复 = 36 km/h", badgeV3 === "已验证" && /36/.test(resV3), `${badgeV3} ${resV3}`);

// ============================================================
// 场景 3：A→B→A 间接循环被拒绝，两条公式不被改写
// ============================================================
const cardA = await addBlankCard();
await setLatex(cardA, "1");
await setNote(cardA, "循环 A");
const cardB = await addBlankCard();
await setLatex(cardB, "2");
await setNote(cardB, "循环 B");
await page.waitForTimeout(200);

// A 引用 B（成功）
await addRef(cardA, /循环 B/, "b_ref");
// 让 A 的表达式真正使用该引用（建立后别名已知，b_ref 会整体识别）
await setLatex(cardA, "b_ref");
check("A→B 引用建立成功且已连接", (await cardA.locator(".ref-item.ok").count()) >= 1,
  await cardA.locator(".refs-panel").innerText());
const aVersionAfterFirst = await cardA.locator(".version-tag").innerText();

// B 再引用 A → 必须被拒绝
await cardB.locator(".ref-source-select").selectOption({ label: /循环 A/ });
await cardB.locator(".ref-alias-input").fill("a_ref");
await cardB.getByRole("button", { name: "建立引用" }).click();
await page.waitForTimeout(300);

const notice = await page.locator(".notice").innerText();
check("拒绝时给出完整环路（A → B → A）",
  notice.includes("循环依赖") && notice.includes("循环 A") && notice.includes("循环 B"), notice);
check("B 没有留下半条引用",
  (await cardB.locator(".ref-item").count()) === 0,
  await cardB.locator(".refs-panel").innerText());
const bVersion = await cardB.locator(".version-tag").innerText();
check("B 的版本未被改写", bVersion === "v1", bVersion);
const aVersionAfterReject = await cardA.locator(".version-tag").innerText();
check("A 的引用与版本保持拒绝前状态", aVersionAfterReject === aVersionAfterFirst, `${aVersionAfterFirst} vs ${aVersionAfterReject}`);
check("A、B 仍正常计算",
  (await cardA.locator(".badge").innerText()) === "已验证" &&
  (await cardB.locator(".badge").innerText()) === "已验证");

// ============================================================
// 持久化：刷新后引用、状态、快照仍准确恢复
// ============================================================
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(600);
const cardsAfterReload = page.locator(".card");
const countAll = await cardsAfterReload.count();
check("刷新后公式数量不变（6 条）", countAll === 6, `实际 ${countAll}`);
// 第 3 张是速度卡
const cardVAfter = cardsAfterReload.nth(2);
check("刷新后速度卡仍已验证 36 km/h",
  (await cardVAfter.locator(".badge").innerText()) === "已验证" &&
  /36/.test(await cardVAfter.locator(".result-row").innerText()),
  await cardVAfter.locator(".result-row").innerText());
check("刷新后引用行恢复（2 条已连接）",
  (await cardVAfter.locator(".ref-item.ok").count()) === 2);

// ============================================================
// 场景 4：导出后导入到已有同名公式的笔记本：重连或明确未解析
// ====================================================
const [downloadPath] = await Promise.all([
  page.waitForEvent("download").then((d) => d.path()),
  page.getByRole("button", { name: "导出 JSON" }).click(),
]);
const fs = await import("node:fs");
const exported = JSON.parse(fs.readFileSync(downloadPath, "utf8"));
check("导出文件为 v2 且含 refs/version",
  exported.version === 2 && exported.formulas.some((f) => f.refs && Object.keys(f.refs).length),
  `version=${exported.version}`);

// 4a) 导入到同 id 已存在的当前笔记本（重复导入）：应重生成 id 并重连
const fileChooser = page.waitForEvent("filechooser");
await page.getByRole("button", { name: "导入 JSON" }).click();
const chooser = await fileChooser;
await chooser.setFiles(downloadPath);
await page.waitForTimeout(600);
const afterDup = await page.locator(".card").count();
check("重复导入后公式翻倍（6 → 12）", afterDup === 12, `实际 ${afterDup}`);
const noticeDup = await page.locator(".notice").innerText();
check("重复导入提示引用已重连", noticeDup.includes("重连"), noticeDup);
// 第二份副本的速度卡 = 6 + 3 = 第 9 张（索引 8）
const dupV = page.locator(".card").nth(8);
check("重复导入副本的速度卡仍已验证（引用重连到正确副本）",
  (await dupV.locator(".badge").innerText()) === "已验证",
  await dupV.locator(".badge").innerText());

// 4b) 导入到“只含同 id 旧公式但结构不同”的笔记本：外部引用未解析 → 阻塞
await page.evaluate(async () => {
  const dbs = await indexedDB.databases?.() ?? [];
  for (const d of dbs) indexedDB.deleteDatabase(d.name);
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(400);
// 构造：只导出“速度卡及其引用”（删掉导出文件中的长度/时间来源），再单独先放入同 id 的无关公式
const speedOnly = {
  ...exported,
  formulas: exported.formulas.filter((f) => f.note === "速度 v"),
};
const tmpPath = "/tmp/ref-unresolved.json";
fs.writeFileSync(tmpPath, JSON.stringify(speedOnly));
const fc2 = page.waitForEvent("filechooser");
await page.getByRole("button", { name: "导入 JSON" }).click();
(await fc2).setFiles(tmpPath);
await page.waitForTimeout(600);
const unresolvedCard = page.locator(".card").last();
const unresolvedNotice = await page.locator(".notice").innerText();
check("未解析引用给出明确提示", unresolvedNotice.includes("未解析"), unresolvedNotice);
const unresolvedBadge = await unresolvedCard.locator(".badge").innerText();
check("未解析下游进入引用阻塞", unresolvedBadge === "引用阻塞", unresolvedBadge);
const unresolvedSnap = await unresolvedCard.locator(".ref-item.blocked").innerText();
check("未解析引用仍保留最后快照供历史查看", /100|10/.test(unresolvedSnap), unresolvedSnap);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (consoleErrors.length) console.log("浏览器控制台错误：", JSON.stringify(consoleErrors.slice(0, 5), null, 1));
await browser.close();
if (failed.length) process.exit(1);
