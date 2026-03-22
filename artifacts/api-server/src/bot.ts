import { Client, GatewayIntentBits } from "discord.js";
import sqlite3pkg from "sqlite3";
import { logger } from "./lib/logger";

const sqlite3 = sqlite3pkg.verbose();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ===== DATABASE =====
const db = new sqlite3.Database("./data.db");

db.run(`CREATE TABLE IF NOT EXISTS users (
  userId TEXT PRIMARY KEY,
  balance INTEGER DEFAULT 0
)`);

db.run(`CREATE TABLE IF NOT EXISTS inventory (
  userId TEXT,
  item TEXT,
  amount INTEGER DEFAULT 0,
  PRIMARY KEY(userId, item)
)`);

db.run(`CREATE TABLE IF NOT EXISTS polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channelId TEXT NOT NULL,
  question TEXT NOT NULL,
  fixedBet INTEGER NOT NULL,
  status TEXT DEFAULT 'open',
  winningNumber INTEGER,
  totalPool INTEGER DEFAULT 0,
  createdBy TEXT NOT NULL
)`);

db.run(`CREATE TABLE IF NOT EXISTS poll_bets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pollId INTEGER NOT NULL,
  userId TEXT NOT NULL,
  guess INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  UNIQUE(pollId, userId)
)`);

db.run(`CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
)`);

// Silently add board columns if they don't exist yet
db.run(`ALTER TABLE polls ADD COLUMN boardMessageId TEXT`, () => {});
db.run(`ALTER TABLE polls ADD COLUMN boardChannelId TEXT`, () => {});

db.run(`CREATE TABLE IF NOT EXISTS wordle_cooldowns (
  userId TEXT PRIMARY KEY,
  lastUsed TEXT NOT NULL
)`);

// ===== USER =====
function getUser(userId: string, cb: (u: { userId: string; balance: number }) => void) {
  db.get(`SELECT * FROM users WHERE userId=?`, [userId], (_err: unknown, row: { userId: string; balance: number } | undefined) => {
    if (!row) {
      db.run(`INSERT INTO users (userId, balance) VALUES (?, 0)`, [userId], () => {
        cb({ userId, balance: 0 });
      });
    } else {
      cb(row);
    }
  });
}

function updateBalance(userId: string, amount: number) {
  db.run(`UPDATE users SET balance = balance + ? WHERE userId=?`, [amount, userId]);
}

// ===== INVENTORY =====
function addItem(userId: string, item: string) {
  db.run(
    `INSERT INTO inventory (userId, item, amount)
     VALUES (?, ?, 1)
     ON CONFLICT(userId, item)
     DO UPDATE SET amount = amount + 1`,
    [userId, item]
  );
}

function removeItem(userId: string, item: string) {
  db.run(
    `UPDATE inventory SET amount = amount - 1 WHERE userId=? AND item=? AND amount > 0`,
    [userId, item]
  );
}

function getItem(userId: string, item: string, cb: (amount: number) => void) {
  db.get(
    `SELECT * FROM inventory WHERE userId=? AND item=?`,
    [userId, item],
    (_err: unknown, row: { amount: number } | undefined) => {
      cb(row ? row.amount : 0);
    }
  );
}

// ===== CONFIG =====
const PRINT_TIERS = [
  { max: 100, reward: 200 },
  { max: 500, reward: 800 },
  { max: 1000, reward: 1600 },
  { max: Infinity, reward: 3000 },
];

const SHOP: Record<string, { name: string; price: number }> = {
  nick: { name: "Nickname Ticket", price: 1000 },
  role: { name: "Role Ticket", price: 2000 },
};

// ===== UI =====
function ui(text: string) {
  return `╭───────────────╮
│ ✦ system ✦
│
${text}
│
╰───────────────╯`;
}

function face() {
  const f = ["(◕‿◕)", "(ᵔᴥᵔ)", "(・ω・)", "(＾◡＾)"];
  return f[Math.floor(Math.random() * f.length)];
}

// ===== POLL TYPES =====
interface PollRow {
  id: number;
  question: string;
  fixedBet: number;
  status: string;
  totalPool: number;
  winningNumber: number | null;
  boardMessageId: string | null;
  boardChannelId: string | null;
}

interface BetRow {
  userId: string;
  guess: number;
  amount: number;
}

// ===== POLL BOARD =====
function buildBoardUi(
  poll: PollRow,
  bets: BetRow[],
  resolved?: { actual: number; winners: BetRow[]; payout: number; exact: boolean }
): string {
  const mult = (b: BetRow) => `×${b.amount / poll.fixedBet}`;

  let text = `│ ✦ pity poll #${poll.id}\n│\n│ ${poll.question}\n│\n`;
  text += `│ fixed bet :: ${poll.fixedBet}\n`;
  text += `│ pool      :: ${poll.totalPool}\n`;
  text += `│ entries   :: ${bets.length}\n│\n`;

  if (bets.length > 0) {
    text += `│ ─ bets ─\n`;
    bets.forEach((b) => {
      const win = resolved && resolved.winners.some((w) => w.userId === b.userId);
      text += `│ <@${b.userId}> · pity ${b.guess} · ${mult(b)}${win ? " ✓" : ""}\n`;
    });
    text += `│\n`;
  }

  if (resolved) {
    text += `│ ─ result ─\n`;
    text += `│ actual pity :: ${resolved.actual}\n`;
    if (resolved.exact) text += `│ ★ exact match — pool ×2\n`;
    text += `│ payout each :: +${resolved.payout}`;
  } else {
    text += `│ !poll bet ${poll.id} <pity> <1|2|3>`;
  }

  return ui(text);
}

async function updateBoardMessage(
  poll: PollRow,
  bets: BetRow[],
  resolved?: { actual: number; winners: BetRow[]; payout: number; exact: boolean }
) {
  if (!poll.boardChannelId || !poll.boardMessageId) return;
  try {
    const channel = await client.channels.fetch(poll.boardChannelId);
    if (!channel || !channel.isTextBased()) return;
    const message = await channel.messages.fetch(poll.boardMessageId);
    await message.edit(buildBoardUi(poll, bets, resolved));
  } catch (e) {
    logger.error(e, "failed to update board message");
  }
}

// ===== NAIRI AUTO =====
client.on("messageCreate", async (msg) => {
  if (!msg.guild) return;
  if (!msg.author.bot) return;
  if (!msg.content.includes("has taken")) return;

  const match = msg.content.match(/<@!?(\d+)> has taken (.+)!/);
  if (!match) return;

  const userId = match[1];
  const cardName = match[2];

  const member = await msg.guild.members.fetch(userId).catch(() => null);
  if (!member) return;

  try {
    if (!msg.channel.isTextBased()) return;
    const messages = await msg.channel.messages.fetch({ limit: 10 });

    const infoMsg = messages.find(
      (m) =>
        m.embeds.length > 0 &&
        m.embeds[0].description != null &&
        m.embeds[0].description.includes(cardName)
    );

    if (!infoMsg) return;

    const desc = infoMsg.embeds[0].description;
    if (!desc) return;

    const line = desc.split("\n").find((l) => l.includes(cardName));
    if (!line) return;

    // Nairi wraps the print number in backticks: `  40`
    const printMatch = line.match(/`\s*(\d+)\s*`/);
    if (!printMatch) return;

    const print = parseInt(printMatch[1]);
    const tier = PRINT_TIERS.find((t) => print <= t.max);
    if (!tier) return;

    // Detect Nairi tier 2 (nt2_s emoji) and apply 1.5x multiplier
    const isCardTier2 = line.includes("nt2_s");
    const reward = isCardTier2 ? Math.floor(tier.reward * 1.5) : tier.reward;
    const tierLabel = isCardTier2 ? " (t2 ×1.5)" : "";

    getUser(userId, () => updateBalance(userId, reward));

    await msg.reply(
      ui(
        `│ card :: ${cardName}
│ print :: ${print}
│ reward :: +${reward}${tierLabel}
│
│ ${face()}`
      )
    );
  } catch (e) {
    logger.error(e, "nairi auto error");
  }
});

// ===== COMMANDS =====
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (!msg.content.startsWith("!")) return;

  const args = msg.content.split(" ");
  const cmd = args[0];

  // BALANCE
  if (cmd === "!bal") {
    getUser(msg.author.id, (u) => {
      msg.reply(ui(`│ balance :: ${u.balance}\n│ ${face()}`));
    });
  }

  // INVENTORY
  if (cmd === "!inv") {
    db.all(
      `SELECT * FROM inventory WHERE userId=?`,
      [msg.author.id],
      (_err: unknown, rows: { item: string; amount: number }[]) => {
        if (!rows || rows.length === 0) {
          return msg.reply(ui(`│ inventory empty`));
        }

        let text = "│ inventory\n│\n";
        rows.forEach((r) => {
          text += `│ ${r.item} x${r.amount}\n`;
        });

        msg.reply(ui(text));
      }
    );
  }

  // SHOP
  if (cmd === "!shop") {
    let text = "│ shop\n│\n";
    for (const key in SHOP) {
      text += `│ ${key} :: $${SHOP[key].price}\n`;
    }
    msg.reply(ui(text));
  }

  // BUY
  if (cmd === "!buy") {
    const item = args[1];
    if (!SHOP[item]) return;

    getUser(msg.author.id, (u) => {
      if (u.balance < SHOP[item].price) {
        return msg.reply(ui(`│ not enough money`));
      }

      updateBalance(msg.author.id, -SHOP[item].price);
      addItem(msg.author.id, item);

      msg.reply(ui(`│ bought ${SHOP[item].name}\n│ ${face()}`));
    });
  }

  // USE NICK
  if (cmd === "!use" && args[1] === "nick") {
    if (!msg.guild) return msg.reply(ui(`│ server only`));
    const user = msg.mentions.members?.first();
    const name = args.slice(3).join(" ");
    if (!user || !name) return msg.reply(ui(`│ invalid usage`));

    getItem(msg.author.id, "nick", async (amt) => {
      if (amt <= 0) return msg.reply(ui(`│ no item`));

      try {
        await user.setNickname(name);
        removeItem(msg.author.id, "nick");
        msg.reply(ui(`│ nickname changed\n│ ${face()}`));
      } catch {
        msg.reply(ui(`│ failed`));
      }
    });
  }

  // USE ROLE
  if (cmd === "!use" && args[1] === "role") {
    if (!msg.guild) return msg.reply(ui(`│ server only`));
    const user = msg.mentions.members?.first();
    const roleName = args.slice(3).join(" ");
    if (!user || !roleName) return msg.reply(ui(`│ invalid usage`));

    getItem(msg.author.id, "role", async (amt) => {
      if (amt <= 0) return msg.reply(ui(`│ no item`));

      let role = msg.guild!.roles.cache.find((r) => r.name === roleName);
      if (!role) role = await msg.guild!.roles.create({ name: roleName });

      await user.roles.add(role);
      removeItem(msg.author.id, "role");

      msg.reply(ui(`│ role given\n│ ${face()}`));
    });
  }

  // BET
  if (cmd === "!bet") {
    const amt = parseInt(args[1]);
    if (isNaN(amt) || amt <= 0) return msg.reply(ui(`│ invalid amount`));

    getUser(msg.author.id, (u) => {
      if (u.balance < amt) return msg.reply(ui(`│ not enough money`));

      updateBalance(msg.author.id, -amt);
      msg.reply(ui(`│ bet placed :: -${amt}`));
    });
  }

  // PAYOUT
  if (cmd === "!payout") {
    if (!msg.member?.permissions.has("Administrator")) return;

    const user = msg.mentions.users.first();
    const amt = parseInt(args[2]);
    if (!user || isNaN(amt)) return;

    updateBalance(user.id, amt);
    msg.reply(ui(`│ payout +${amt}`));
  }

  // POLL
  if (cmd === "!poll") {
    const sub = args[1];

    // !poll setchannel
    if (sub === "setchannel") {
      const isAdmin = msg.member?.permissions.has("Administrator");
      const isDev = msg.member?.roles.cache.some((r) => r.name.toLowerCase() === "developer");
      if (!isAdmin && !isDev) return msg.reply(ui(`│ admin or developer only`));
      db.run(`INSERT OR REPLACE INTO config (key, value) VALUES ('pollChannelId', ?)`, [msg.channel.id]);
      return msg.reply(ui(`│ poll board channel set`));
    }

    // !poll create <fixedBet> <question>
    if (sub === "create") {
      if (!msg.member?.permissions.has("Administrator")) return msg.reply(ui(`│ admin only`));

      const fixedBet = parseInt(args[2]);
      const question = args.slice(3).join(" ");

      if (!args[2]) return msg.reply(ui(`│ missing :: <amount>`));
      if (isNaN(fixedBet) || fixedBet <= 0) return msg.reply(ui(`│ invalid :: <amount> must be a positive number`));
      if (!question) return msg.reply(ui(`│ missing :: <question>`));

      db.run(
        `INSERT INTO polls (channelId, question, fixedBet, createdBy) VALUES (?, ?, ?, ?)`,
        [msg.channel.id, question, fixedBet, msg.author.id],
        function (this: { lastID: number }, err: unknown) {
          if (err) return msg.reply(ui(`│ error creating poll`));
          const id = this.lastID;

          msg.reply(ui(
`│ ✦ pity poll #${id} created
│
│ ${question}
│
│ fixed bet  :: ${fixedBet}
│ multiplier :: ×1 · ×2 · ×3
│
│ !poll bet ${id} <pity> <1|2|3>`
          ));

          // Send board message to configured poll channel
          db.get(
            `SELECT value FROM config WHERE key='pollChannelId'`,
            [],
            async (_ce: unknown, row: { value: string } | undefined) => {
              if (!row) return;
              try {
                const ch = await client.channels.fetch(row.value);
                if (!ch || !ch.isTextBased()) return;
                const initPoll: PollRow = {
                  id, question, fixedBet, status: "open",
                  totalPool: 0, winningNumber: null,
                  boardMessageId: null, boardChannelId: row.value,
                };
                const boardMsg = await ch.send(buildBoardUi(initPoll, []));
                db.run(
                  `UPDATE polls SET boardMessageId=?, boardChannelId=? WHERE id=?`,
                  [boardMsg.id, row.value, id]
                );
              } catch (e) {
                logger.error(e, "failed to send board message");
              }
            }
          );
        }
      );
    }

    // !poll bet <id> <guess> <1|2|3>
    else if (sub === "bet") {
      if (!args[2]) return msg.reply(ui(`│ missing :: <poll id>`));
      if (!args[3]) return msg.reply(ui(`│ missing :: <pity guess>`));
      if (!args[4]) return msg.reply(ui(`│ missing :: <multiplier> — use 1, 2 or 3`));

      const pollId = parseInt(args[2]);
      const guess = parseInt(args[3]);
      const mult = parseInt(args[4]);

      if (isNaN(pollId)) return msg.reply(ui(`│ invalid :: <poll id> must be a number`));
      if (isNaN(guess) || guess < 1) return msg.reply(ui(`│ invalid :: <pity guess> must be a positive number`));
      if (![1, 2, 3].includes(mult)) return msg.reply(ui(`│ invalid :: <multiplier> must be 1, 2 or 3`));

      db.get(
        `SELECT * FROM polls WHERE id=?`,
        [pollId],
        (_err: unknown, poll: PollRow | undefined) => {
          if (!poll) return msg.reply(ui(`│ poll #${pollId} not found`));
          if (poll.status !== "open") return msg.reply(ui(`│ poll #${pollId} is closed`));

          const amount = poll.fixedBet * mult;

          getUser(msg.author.id, (u) => {
            if (u.balance < amount) {
              return msg.reply(ui(`│ not enough money\n│ need :: ${amount}\n│ have :: ${u.balance}`));
            }

            db.run(
              `INSERT INTO poll_bets (pollId, userId, guess, amount) VALUES (?, ?, ?, ?)`,
              [pollId, msg.author.id, guess, amount],
              (insertErr: unknown) => {
                if (insertErr) return msg.reply(ui(`│ already bet on poll #${pollId}`));

                updateBalance(msg.author.id, -amount);
                db.run(`UPDATE polls SET totalPool = totalPool + ? WHERE id=?`, [amount, pollId]);

                msg.reply(ui(
`│ ✦ poll #${pollId}
│
│ guess :: pity ${guess}
│ bet   :: ${amount} (×${mult})
│ pool  :: ${poll.totalPool + amount}
│
│ ${face()}`
                ));

                // Refresh board message
                db.get(`SELECT * FROM polls WHERE id=?`, [pollId], (_e: unknown, updated: PollRow | undefined) => {
                  if (!updated) return;
                  db.all(`SELECT * FROM poll_bets WHERE pollId=?`, [pollId], (_e2: unknown, allBets: BetRow[]) => {
                    updateBoardMessage(updated, allBets);
                  });
                });
              }
            );
          });
        }
      );
    }

    // !poll info <id>
    else if (sub === "info") {
      if (!args[2]) return msg.reply(ui(`│ missing :: <poll id>`));
      const pollId = parseInt(args[2]);
      if (isNaN(pollId)) return msg.reply(ui(`│ invalid :: <poll id> must be a number`));

      db.get(
        `SELECT * FROM polls WHERE id=?`,
        [pollId],
        (_err: unknown, poll: PollRow | undefined) => {
          if (!poll) return msg.reply(ui(`│ poll #${pollId} not found`));

          db.get(
            `SELECT COUNT(*) as count FROM poll_bets WHERE pollId=?`,
            [pollId],
            (_e: unknown, row: { count: number }) => {
              const statusLine = poll.status === "open"
                ? "│ status :: open"
                : `│ status :: closed\n│ result :: pity ${poll.winningNumber}`;

              msg.reply(ui(
`│ ✦ poll #${poll.id}
│
│ ${poll.question}
│
│ fixed bet :: ${poll.fixedBet}
│ pool      :: ${poll.totalPool}
│ entries   :: ${row.count}
${statusLine}`
              ));
            }
          );
        }
      );
    }

    // !poll list
    else if (sub === "list") {
      db.all(
        `SELECT * FROM polls WHERE status='open' ORDER BY id DESC LIMIT 5`,
        [],
        (_err: unknown, rows: PollRow[]) => {
          if (!rows || rows.length === 0) return msg.reply(ui(`│ no open polls`));

          let text = "│ ✦ open polls\n│\n";
          rows.forEach((p) => {
            text += `│ #${p.id} :: ${p.question}\n`;
            text += `│     pool :: ${p.totalPool} · bet :: ${p.fixedBet}\n│\n`;
          });
          msg.reply(ui(text.trimEnd()));
        }
      );
    }

    // !poll resolve <id> <actualPity>
    else if (sub === "resolve") {
      if (!msg.member?.permissions.has("Administrator")) return msg.reply(ui(`│ admin only`));

      if (!args[2]) return msg.reply(ui(`│ missing :: <poll id>`));
      if (!args[3]) return msg.reply(ui(`│ missing :: <actual pity>`));

      const pollId = parseInt(args[2]);
      const actual = parseInt(args[3]);

      if (isNaN(pollId)) return msg.reply(ui(`│ invalid :: <poll id> must be a number`));
      if (isNaN(actual) || actual < 1) return msg.reply(ui(`│ invalid :: <actual pity> must be a positive number`));

      db.get(
        `SELECT * FROM polls WHERE id=?`,
        [pollId],
        (_err: unknown, poll: PollRow | undefined) => {
          if (!poll) return msg.reply(ui(`│ poll #${pollId} not found`));
          if (poll.status !== "open") return msg.reply(ui(`│ poll #${pollId} already resolved`));

          db.all(
            `SELECT * FROM poll_bets WHERE pollId=?`,
            [pollId],
            async (_e: unknown, bets: BetRow[]) => {
              db.run(`UPDATE polls SET status='closed', winningNumber=? WHERE id=?`, [actual, pollId]);

              if (!bets || bets.length === 0) {
                msg.reply(ui(`│ poll #${pollId} closed\n│ no bets were placed`));
                // Update board to show closed with no bets
                const closedPoll = { ...poll, status: "closed", winningNumber: actual };
                updateBoardMessage(closedPoll, [], { actual, winners: [], payout: 0, exact: false });
                return;
              }

              const minDiff = Math.min(...bets.map((b) => Math.abs(b.guess - actual)));
              const winners = bets.filter((b) => Math.abs(b.guess - actual) === minDiff);
              const exactMatch = minDiff === 0;

              let pool = poll.totalPool;
              if (exactMatch) pool = pool * 2;
              const share = Math.floor(pool / winners.length);

              winners.forEach((w) => updateBalance(w.userId, share));

              const winnerTags = winners.map((w) => `<@${w.userId}> (guessed ${w.guess})`);
              const exactLine = exactMatch ? "│ ★ exact match — pool ×2\n" : "";

              msg.reply(ui(
`│ ✦ poll #${pollId} resolved
│
│ ${poll.question}
│
│ actual pity :: ${actual}
│ pool        :: ${exactMatch ? `${poll.totalPool} → ${pool} (×2)` : `${pool}`}
│ each winner :: +${share}
${exactLine}│
│ winner${winners.length > 1 ? "s" : ""} ::
${winnerTags.map((t) => `│ ${t}`).join("\n")}`
              ));

              // Update board message with final result
              const resolvedPoll = { ...poll, status: "closed", totalPool: pool, winningNumber: actual };
              updateBoardMessage(resolvedPoll, bets, { actual, winners, payout: share, exact: exactMatch });
            }
          );
        }
      );
    }

    else {
      msg.reply(ui(
`│ ✦ poll commands
│
│ !poll setchannel        [admin/developer]
│ !poll create <bet> <question>  [admin]
│ !poll bet <id> <pity> <1|2|3>
│ !poll info <id>
│ !poll list
│ !poll resolve <id> <pity>   [admin]`
      ));
    }
  }

  // WORDLE
  if (cmd === "!wordle") {
    if (!args[1]) return msg.reply(ui(`│ missing :: <tries> (1-6)`));
    const tries = parseInt(args[1]);
    if (isNaN(tries) || tries < 1 || tries > 6) {
      return msg.reply(ui(`│ invalid :: <tries> must be between 1 and 6`));
    }

    // Daily cooldown — resets at 12:00 noon
    const now = new Date();
    const lastNoon = new Date();
    lastNoon.setHours(12, 0, 0, 0);
    if (now < lastNoon) lastNoon.setDate(lastNoon.getDate() - 1);

    db.get(
      `SELECT lastUsed FROM wordle_cooldowns WHERE userId=?`,
      [msg.author.id],
      (_err: unknown, row: { lastUsed: string } | undefined) => {
        if (row) {
          const lastUsed = new Date(row.lastUsed);
          if (lastUsed >= lastNoon) {
            const nextNoon = new Date(lastNoon);
            nextNoon.setDate(nextNoon.getDate() + 1);
            const hoursLeft = Math.ceil((nextNoon.getTime() - now.getTime()) / 3600000);
            return msg.reply(ui(`│ already claimed today\n│ resets in :: ~${hoursLeft}h (at 12:00)`));
          }
        }

        let reward = 0;
        let text = "";
        if (tries === 1) { reward = 1500; text = "insane"; }
        else if (tries === 2) { reward = 1200; text = "amazing"; }
        else if (tries === 3) { reward = 900; text = "great"; }
        else if (tries === 4) { reward = 600; text = "good"; }
        else if (tries === 5) { reward = 400; text = "ok"; }
        else { reward = 200; text = "barely"; }

        updateBalance(msg.author.id, reward);
        db.run(
          `INSERT OR REPLACE INTO wordle_cooldowns (userId, lastUsed) VALUES (?, ?)`,
          [msg.author.id, now.toISOString()]
        );

        msg.reply(ui(
`│ wordle ${tries}/6
│ ${text}
│ reward :: +${reward}
│
│ ${face()}`
        ));
      }
    );
  }

  // HELP
  if (cmd === "!help") {
    msg.reply(ui(
`│ ✦ commands
│
│ ─ economy ─
│ !bal
│   your current balance
│ !bet <amount>
│   place a manual bet
│ !payout @user <amount>   [admin]
│   give coins to a user
│
│ ─ shop ─
│ !shop
│   list available items
│ !buy <item>
│   buy an item from the shop
│ !inv
│   view your inventory
│
│ ─ items ─
│ !use nick @user <name>
│   change a user's nickname
│ !use role @user <role>
│   give a user a role
│
│ ─ rewards ─
│ !wordle <tries 1-6>
│   claim daily wordle reward
│   resets every day at 12:00
│
│ ─ polls ─
│ !poll setchannel   [admin/dev]
│   set this channel as board
│ !poll create <bet> <question>   [admin]
│   open a new pity poll
│ !poll bet <id> <pity> <1|2|3>
│   place a bet on a poll
│ !poll info <id>
│   view poll details
│ !poll list
│   list open polls
│ !poll resolve <id> <pity>   [admin]
│   close poll and pay winners`
    ));
  }
});

// READY
client.once("clientReady", () => {
  logger.info("discord bot ready");
});

export function startBot() {
  client.login(process.env.TOKEN);
}
