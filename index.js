const {
  Client,
  GatewayIntentBits,
  ActivityType,
  EmbedBuilder,
  Events,
} = require("discord.js");
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const CONFIG = {
  GUILD_ID: process.env.DISCORD_GUILD_ID || "1529719324959572099",
  WELCOME_CHANNEL_ID: process.env.WELCOME_CHANNEL_ID || "",
  LEAVE_CHANNEL_ID: process.env.LEAVE_CHANNEL_ID || "",
  INVITE_LOG_CHANNEL_ID: process.env.INVITE_LOG_CHANNEL_ID || "",
  BRAND_NAME: "Astral MC",
  BRAND_COLOR: 0x3b82f6,
  INVITE_DB_FILE: process.env.INVITE_DB_FILE || path.join(__dirname, "invite-tracking.json"),
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
  ],
});

const inviteCache = new Map();

function loadInviteDb() {
  try {
    if (!fs.existsSync(CONFIG.INVITE_DB_FILE)) return {};
    return JSON.parse(fs.readFileSync(CONFIG.INVITE_DB_FILE, "utf8"));
  } catch (error) {
    console.error("Erro lendo invite-tracking.json:", error);
    return {};
  }
}

let inviteDb = loadInviteDb();

function saveInviteDb() {
  try {
    fs.mkdirSync(path.dirname(CONFIG.INVITE_DB_FILE), { recursive: true });
    fs.writeFileSync(CONFIG.INVITE_DB_FILE, JSON.stringify(inviteDb, null, 2), "utf8");
  } catch (error) {
    console.error("Erro salvando invite-tracking.json:", error);
  }
}

function avatarUrl(user) {
  return user.displayAvatarURL({ size: 256 });
}

function memberLabel(member) {
  return member.user.globalName || member.user.username;
}

function formatDate(date) {
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      dateStyle: "short",
      timeStyle: "short",
    }).format(date);
  } catch {
    return date.toLocaleString("pt-BR");
  }
}

async function fetchGuildInvites(guild) {
  try {
    const invites = await guild.invites.fetch();
    const map = new Map();

    for (const invite of invites.values()) {
      map.set(invite.code, {
        code: invite.code,
        uses: invite.uses || 0,
        inviterId: invite.inviter?.id || null,
        inviterTag: invite.inviter?.tag || null,
      });
    }

    inviteCache.set(guild.id, map);
    return map;
  } catch (error) {
    console.error(`[INVITES] Não consegui buscar convites de ${guild.name}:`, error);
    return null;
  }
}

function detectUsedInvite(before, after) {
  if (!before || !after) return null;

  let best = null;

  for (const [code, current] of after.entries()) {
    const previous = before.get(code);
    const oldUses = previous?.uses || 0;
    const newUses = current?.uses || 0;

    if (newUses > oldUses) {
      const delta = newUses - oldUses;
      if (!best || delta > best.delta) {
        best = { ...current, delta };
      }
    }
  }

  return best;
}

async function sendWelcome(member, inviteInfo) {
  if (!CONFIG.WELCOME_CHANNEL_ID) return;

  const channel = await member.guild.channels.fetch(CONFIG.WELCOME_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const inviterText = inviteInfo?.inviterId
    ? `<@${inviteInfo.inviterId}>`
    : "Não identificado";

  const inviteCodeText = inviteInfo?.code
    ? `\`${inviteInfo.code}\``
    : "Não identificado";

  const embed = new EmbedBuilder()
    .setColor(CONFIG.BRAND_COLOR)
    .setTitle("👋 Bem-vindo(a) à Astral MC!")
    .setDescription(
      `Seja muito bem-vindo(a), <@${member.id}>!\n\n` +
      `Agora somos **${member.guild.memberCount} membros** no servidor. 💫`
    )
    .addFields(
      { name: "👤 Usuário", value: `<@${member.id}>`, inline: true },
      { name: "🔗 Convidado por", value: inviterText, inline: true },
      { name: "🎟️ Convite usado", value: inviteCodeText, inline: true }
    )
    .setThumbnail(avatarUrl(member.user))
    .setFooter({ text: "Astral MC • Seja bem-vindo!" })
    .setTimestamp();

  await channel.send({
    content: `<@${member.id}>`,
    embeds: [embed],
    allowedMentions: { users: [member.id] },
  });
}

async function sendLeave(member, savedInvite) {
  if (!CONFIG.LEAVE_CHANNEL_ID) return;

  const channel = await member.guild.channels.fetch(CONFIG.LEAVE_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const inviterText = savedInvite?.inviterId
    ? `<@${savedInvite.inviterId}>`
    : "Não identificado";

  const joinedAt = member.joinedAt
    ? formatDate(member.joinedAt)
    : "Não disponível";

  const embed = new EmbedBuilder()
    .setColor(0xef4444)
    .setTitle("👋 Um membro saiu")
    .setDescription(`**${memberLabel(member)}** saiu da Astral MC.`)
    .addFields(
      { name: "👤 Usuário", value: `${member.user.tag}\n\`${member.id}\``, inline: true },
      { name: "🔗 Quem convidou", value: inviterText, inline: true },
      { name: "📅 Entrou em", value: joinedAt, inline: true }
    )
    .setThumbnail(avatarUrl(member.user))
    .setFooter({ text: `Astral MC • Agora: ${member.guild.memberCount} membros` })
    .setTimestamp();

  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function sendInviteLog(member, inviteInfo) {
  if (!CONFIG.INVITE_LOG_CHANNEL_ID) return;

  const channel = await member.guild.channels.fetch(CONFIG.INVITE_LOG_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const inviterText = inviteInfo?.inviterId
    ? `<@${inviteInfo.inviterId}>`
    : "Não identificado";

  const codeText = inviteInfo?.code ? `\`${inviteInfo.code}\`` : "Não identificado";

  const embed = new EmbedBuilder()
    .setColor(CONFIG.BRAND_COLOR)
    .setTitle("📨 Rastreamento de convite")
    .addFields(
      { name: "Entrou", value: `<@${member.id}>`, inline: true },
      { name: "Convidado por", value: inviterText, inline: true },
      { name: "Código", value: codeText, inline: true }
    )
    .setTimestamp();

  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
}

client.once(Events.ClientReady, async () => {
  console.log("----------------------------------");
  console.log("✅ Bot conectado!");
  console.log(`🤖 Nome: ${client.user.tag}`);
  console.log(`🆔 ID: ${client.user.id}`);
  console.log("----------------------------------");

  client.user.setPresence({
    activities: [{ name: "💫 Astral MC", type: ActivityType.Watching }],
    status: "online",
  });

  for (const guild of client.guilds.cache.values()) {
    await fetchGuildInvites(guild);
  }
});

client.on(Events.InviteCreate, async (invite) => {
  if (!invite.guild) return;
  await fetchGuildInvites(invite.guild);
});

client.on(Events.InviteDelete, async (invite) => {
  if (!invite.guild) return;
  await fetchGuildInvites(invite.guild);
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const before = inviteCache.get(member.guild.id) || new Map();
    const after = await fetchGuildInvites(member.guild);
    const usedInvite = detectUsedInvite(before, after);

    const record = {
      memberId: member.id,
      username: member.user.tag,
      inviterId: usedInvite?.inviterId || null,
      inviterTag: usedInvite?.inviterTag || null,
      inviteCode: usedInvite?.code || null,
      joinedAt: new Date().toISOString(),
    };

    inviteDb[member.id] = record;
    saveInviteDb();

    await Promise.allSettled([
      sendWelcome(member, usedInvite),
      sendInviteLog(member, usedInvite),
    ]);
  } catch (error) {
    console.error("[JOIN] Erro processando entrada:", error);
    await sendWelcome(member, null).catch(() => {});
  }
});

client.on(Events.GuildMemberRemove, async (member) => {
  try {
    const savedInvite = inviteDb[member.id] || null;
    await sendLeave(member, savedInvite);
  } catch (error) {
    console.error("[LEAVE] Erro processando saída:", error);
  }
});

client.on("error", console.error);

app.get("/", (req, res) => {
  res.json({
    ok: true,
    bot: "Astral MC Gateway Bot",
    status: client.isReady() ? "online" : "connecting",
    features: {
      inviteTracking: true,
      welcomeMessages: !!CONFIG.WELCOME_CHANNEL_ID,
      leaveMessages: !!CONFIG.LEAVE_CHANNEL_ID,
    },
  });
});

app.get("/health", (req, res) => {
  res.status(client.isReady() ? 200 : 503).json({
    ok: client.isReady(),
    bot: client.user?.tag || null,
    guilds: client.guilds.cache.size,
  });
});

app.listen(PORT, () => {
  console.log(`Servidor web iniciado na porta ${PORT}`);
});

client.login(process.env.DISCORD_TOKEN);
