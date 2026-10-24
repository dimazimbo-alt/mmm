import { Bot, webhookCallback } from "grammy";
import { launch, type BrowserWorker } from "@cloudflare/playwright";

interface Env {
  BOT_TOKEN: string;
  MYBROWSER: BrowserWorker;
}

// Временное хранилище диалогов. В production замените на KV/Durable Objects.
const sessions = new Map<number, {
  step: "users" | "old" | "new";
  users?: Array<{ username: string; password: string }>;
  oldText?: string;
  newText?: string;
}>();

const BASE = "https://agridata.ansd.sn";

async function updateAbout(
  browser: BrowserWorker,
  username: string,
  password: string,
  oldFragment: string,
  newFragment: string
): Promise<{ ok: boolean; msg: string }> {
  const b = await launch(browser);
  const context = await b.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${BASE}/user/login`, { waitUntil: "domcontentloaded" });
    await page.fill('input[name="login"]', username);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"], input[type="submit"]');
    await page.waitForLoadState("networkidle");

    if (page.url().includes("/user/login")) {
      return { ok: false, msg: "Ошибка входа (проверьте пароль)" };
    }

    await page.goto(`${BASE}/user/edit/${username}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('textarea[name="about"]', { timeout: 10000 });

    const textarea = page.locator('textarea[name="about"]');
    const current = await textarea.inputValue();

    if (!current.includes(oldFragment)) {
      return { ok: false, msg: `Фрагмент не найден. Текущее: ${current.slice(0, 80)}...` };
    }

    await textarea.fill(current.replace(oldFragment, newFragment));
    await page.click('button[name="save"]');
    await page.waitForLoadState("networkidle");

    if (page.url().includes("/user/edit")) {
      const errors = await page.locator('.error-explanation, .alert-danger').allInnerTexts();
      return { ok: false, msg: `Ошибка сохранения: ${errors.join("; ") || "неизвестно"}` };
    }

    return { ok: true, msg: "Профиль обновлён" };
  } catch (e: any) {
    return { ok: false, msg: e.message?.slice(0, 150) || String(e) };
  } finally {
    await context.close();
    await b.close();
  }
}

function createBot(env: Env) {
  const bot = new Bot(env.BOT_TOKEN);

  bot.command("start", (ctx) => {
    ctx.reply(
      "Отправьте /update для начала.\n\n" +
      "Формат:\n" +
      "1) Список username:password (по одному на строку)\n" +
      "2) Старый фрагмент\n" +
      "3) Новый фрагмент"
    );
  });

  bot.command("update", async (ctx) => {
    const uid = ctx.from!.id;
    sessions.set(uid, { step: "users" });
    await ctx.reply("Отправьте список в формате:\nusername:password\n(по одному на строку)");
  });

  bot.on("message:text", async (ctx) => {
    const uid = ctx.from!.id;
    const session = sessions.get(uid);

    if (!session) {
      await ctx.reply("Отправьте /update для начала.");
      return;
    }

    const text = ctx.message.text.trim();

    if (session.step === "users") {
      const users = text.split("\n")
        .map(line => line.trim())
        .filter(line => line.includes(":"))
        .map(line => {
          const [u, ...p] = line.split(":");
          return { username: u.trim(), password: p.join(":").trim() };
        });

      if (users.length === 0) {
        await ctx.reply("Формат неверен. Нужно username:password на каждой строке.");
        return;
      }

      session.users = users;
      session.step = "old";
      await ctx.reply(`Принято ${users.length} пользователей.\nОтправьте старый фрагмент.`);
      return;
    }

    if (session.step === "old") {
      session.oldText = text;
      session.step = "new";
      await ctx.reply("Отправьте новый фрагмент.");
      return;
    }

    if (session.step === "new") {
      session.newText = text;
      const { users, oldText, newText } = session;
      sessions.delete(uid);

      await ctx.reply(`Начинаю обработку ${users!.length} пользователей...`);

      const results: string[] = [];
      for (const u of users!) {
        const r = await updateAbout(env.MYBROWSER, u.username, u.password, oldText!, newText!);
        results.push(`${u.username}: ${r.ok ? "✅" : "❌"} ${r.msg}`);
      }

      await ctx.reply(results.join("\n"));
    }
  });

  return bot;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const bot = createBot(env);
    return webhookCallback(bot, "cloudflare")(request);
  },
};
