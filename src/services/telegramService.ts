/**
 * Telegram Bot API helpers for student order notifications.
 *
 * Linking is student-only: a one-time deep-link code is minted for the logged-in
 * student, they open t.me/<bot>?start=<code>, and the webhook stores their
 * chat id. Staff and guests are never linked and never messaged.
 *
 * Failures to reach Telegram are logged and swallowed so an outage never fails
 * an order write.
 */
import type { PrismaClient } from "@prisma/client";
import { ApiError } from "../middleware/errorHandler.js";

const LINK_TTL_MS = 15 * 60 * 1000;
const API_BASE = "https://api.telegram.org";

export interface TelegramEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_BOT_USERNAME?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}

function tokenOrThrow(env: TelegramEnv): string {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    throw new ApiError(503, "TELEGRAM_NOT_CONFIGURED", "Telegram bot is not configured.");
  }
  return token;
}

async function telegramApi<T>(
  env: TelegramEnv,
  method: string,
  body?: Record<string, unknown>
): Promise<T | null> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return null;

  try {
    const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!data.ok) {
      console.error(`[telegram] ${method} failed:`, data.description ?? res.status);
      return null;
    }
    return data.result ?? null;
  } catch (err) {
    console.error(`[telegram] ${method} error`, err);
    return null;
  }
}

export async function sendTelegramMessage(
  env: TelegramEnv,
  chatId: string,
  text: string
): Promise<boolean> {
  const result = await telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
  return result !== null;
}

export async function resolveBotUsername(env: TelegramEnv): Promise<string> {
  const configured = env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
  if (configured) return configured;

  tokenOrThrow(env);
  const me = await telegramApi<{ username?: string }>(env, "getMe");
  const username = me?.username?.trim();
  if (!username) {
    throw new ApiError(
      503,
      "TELEGRAM_BOT_USERNAME_MISSING",
      "Could not resolve the bot username. Set TELEGRAM_BOT_USERNAME."
    );
  }
  return username;
}

function randomLinkCode(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface TelegramStatus {
  linked: boolean;
  username: string | null;
  linkedAt: string | null;
  botUsername: string | null;
}

export async function getTelegramStatus(
  prisma: PrismaClient,
  env: TelegramEnv,
  studentId: string
): Promise<TelegramStatus> {
  const user = await prisma.user.findUnique({
    where: { id: studentId },
    select: {
      role: true,
      telegramChatId: true,
      telegramUsername: true,
      telegramLinkedAt: true,
    },
  });
  if (!user || user.role !== "STUDENT") {
    throw new ApiError(403, "FORBIDDEN", "Only students can link Telegram.");
  }

  let botUsername: string | null = null;
  if (env.TELEGRAM_BOT_TOKEN?.trim()) {
    try {
      botUsername = await resolveBotUsername(env);
    } catch {
      botUsername = env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "") ?? null;
    }
  }

  return {
    linked: Boolean(user.telegramChatId),
    username: user.telegramUsername,
    linkedAt: user.telegramLinkedAt?.toISOString() ?? null,
    botUsername,
  };
}

export interface LinkStartResult {
  deepLink: string;
  expiresAt: string;
  botUsername: string;
}

/** Mint a fresh deep-link code for this student. Replaces any previous pending code. */
export async function startTelegramLink(
  prisma: PrismaClient,
  env: TelegramEnv,
  studentId: string
): Promise<LinkStartResult> {
  tokenOrThrow(env);
  const botUsername = await resolveBotUsername(env);

  const user = await prisma.user.findUnique({
    where: { id: studentId },
    select: { id: true, role: true, telegramChatId: true },
  });
  if (!user || user.role !== "STUDENT") {
    throw new ApiError(403, "FORBIDDEN", "Only students can link Telegram.");
  }
  if (user.telegramChatId) {
    throw new ApiError(409, "ALREADY_LINKED", "Telegram is already linked. Unlink first to re-link.");
  }

  const code = randomLinkCode();
  const expiresAt = new Date(Date.now() + LINK_TTL_MS);

  await prisma.user.update({
    where: { id: studentId },
    data: { telegramLinkCode: code, telegramLinkExpiresAt: expiresAt },
  });

  return {
    deepLink: `https://t.me/${botUsername}?start=${code}`,
    expiresAt: expiresAt.toISOString(),
    botUsername,
  };
}

export async function unlinkTelegram(
  prisma: PrismaClient,
  studentId: string
): Promise<{ unlinked: true }> {
  const user = await prisma.user.findUnique({
    where: { id: studentId },
    select: { id: true, role: true, telegramChatId: true },
  });
  if (!user || user.role !== "STUDENT") {
    throw new ApiError(403, "FORBIDDEN", "Only students can unlink Telegram.");
  }
  if (!user.telegramChatId) {
    throw new ApiError(409, "NOT_LINKED", "Telegram is not linked.");
  }

  await prisma.user.update({
    where: { id: studentId },
    data: {
      telegramChatId: null,
      telegramUsername: null,
      telegramLinkedAt: null,
      telegramLinkCode: null,
      telegramLinkExpiresAt: null,
    },
  });

  return { unlinked: true };
}

interface TelegramUpdate {
  update_id?: number;
  message?: {
    text?: string;
    chat?: { id?: number | string; type?: string };
    from?: { username?: string; id?: number };
  };
}

/**
 * Handle an inbound Telegram update. Completes linking when the student
 * presses Start with a valid one-time code.
 */
export async function handleTelegramUpdate(
  prisma: PrismaClient,
  env: TelegramEnv,
  update: TelegramUpdate
): Promise<void> {
  const text = update.message?.text?.trim() ?? "";
  const chatId = update.message?.chat?.id;
  if (chatId == null) return;

  const chatIdStr = String(chatId);
  const username = update.message?.from?.username ?? null;

  if (!text.startsWith("/start")) {
    if (text === "/unlink" || text === "/status") {
      const linked = await prisma.user.findFirst({
        where: { telegramChatId: chatIdStr, role: "STUDENT" },
        select: { rollNumber: true, name: true },
      });
      if (text === "/status") {
        await sendTelegramMessage(
          env,
          chatIdStr,
          linked
            ? `Linked to KLH Canteen as ${linked.rollNumber ?? "—"} (${linked.name}).`
            : "This Telegram account is not linked. Open the student app → Telegram → Link."
        );
      } else {
        await sendTelegramMessage(
          env,
          chatIdStr,
          "To unlink, open the student app → Telegram → Unlink."
        );
      }
    }
    return;
  }

  const payload = text.replace(/^\/start\s*/i, "").trim();
  if (!payload) {
    await sendTelegramMessage(
      env,
      chatIdStr,
      "Open the KLH Canteen student app and tap Link Telegram to get your personal link."
    );
    return;
  }

  const student = await prisma.user.findFirst({
    where: {
      role: "STUDENT",
      telegramLinkCode: payload,
      telegramLinkExpiresAt: { gt: new Date() },
    },
    select: { id: true, name: true, rollNumber: true },
  });

  if (!student) {
    await sendTelegramMessage(
      env,
      chatIdStr,
      "This link is invalid or expired. Generate a new one from the student app."
    );
    return;
  }

  const taken = await prisma.user.findFirst({
    where: { telegramChatId: chatIdStr, NOT: { id: student.id } },
    select: { id: true },
  });
  if (taken) {
    await sendTelegramMessage(
      env,
      chatIdStr,
      "This Telegram account is already linked to another student. Unlink there first."
    );
    return;
  }

  await prisma.user.update({
    where: { id: student.id },
    data: {
      telegramChatId: chatIdStr,
      telegramUsername: username,
      telegramLinkedAt: new Date(),
      telegramLinkCode: null,
      telegramLinkExpiresAt: null,
    },
  });

  const roll = student.rollNumber ?? "—";
  await sendTelegramMessage(
    env,
    chatIdStr,
    `Telegram successfully linked for roll number ${roll}, ${student.name}.\n\nYou will receive order updates here.`
  );
}

export interface NotifyOrderInput {
  studentId: string | null | undefined;
  orderNumber: number;
  status: string;
  kitchen: string;
  totalAmount: string | number | { toString(): string };
  items?: { name: string; quantity: number }[];
  previousStatus?: string;
  kind: "created" | "status";
}

/**
 * Send an order log to the student's linked Telegram chat. No-ops for guests,
 * unlinked students, or missing bot config.
 */
export async function notifyStudentOrderTelegram(
  prisma: PrismaClient,
  env: TelegramEnv,
  input: NotifyOrderInput
): Promise<void> {
  if (!input.studentId || !env.TELEGRAM_BOT_TOKEN?.trim()) return;

  const user = await prisma.user.findUnique({
    where: { id: input.studentId },
    select: { role: true, telegramChatId: true, name: true, rollNumber: true },
  });
  if (!user || user.role !== "STUDENT" || !user.telegramChatId) return;

  const lines: string[] = [];
  if (input.kind === "created") {
    lines.push(`Order #${input.orderNumber} placed`);
  } else {
    lines.push(`Order #${input.orderNumber} update`);
    if (input.previousStatus) {
      lines.push(`Status: ${input.previousStatus} → ${input.status}`);
    } else {
      lines.push(`Status: ${input.status}`);
    }
  }
  lines.push(`Kitchen: ${input.kitchen}`);
  if (input.items && input.items.length > 0) {
    lines.push("Items:", ...input.items.map((i) => `  • ${i.name} × ${i.quantity}`));
  }
  lines.push(`Total: ₹${Number(input.totalAmount).toFixed(2)}`);
  if (input.kind === "created") {
    lines.push(`Status: ${input.status}`);
  }
  lines.push(`Student: ${user.rollNumber ?? "—"} (${user.name})`);

  await sendTelegramMessage(env, user.telegramChatId, lines.join("\n"));
}

export function verifyWebhookSecret(env: TelegramEnv, headerValue: string | undefined): boolean {
  const expected = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!expected) return true;
  return Boolean(headerValue) && headerValue === expected;
}
