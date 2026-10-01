// 端到端冒烟：真实浏览器中加载 5 个示例公式，验证状态徽章、量纲定位、KaTeX 渲染与隔离
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

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (consoleErrors.length) console.log("浏览器控制台错误：", JSON.stringify(consoleErrors.slice(0, 5), null, 1));
await browser.close();
if (failed.length) process.exit(1);
