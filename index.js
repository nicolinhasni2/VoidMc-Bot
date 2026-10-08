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
  BOT_USER_ID: process.env.ASTRAL_BOT_USER_ID || "1543661656125608060",
  INVITE_DB_FILE: process.env.INVITE_DB_FILE || path.join(__dirname, "invite-tracking.json"),
  WELCOME_BANNER_FILE: process.env.WELCOME_BANNER_FILE || path.join(__dirname, "astralbanner.png"),
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
  ],
});

// Registro dos comandos mantidos pelo Cloudflare. O Railway apenas solicita
// o registro ao Worker; os comandos e tickets continuam executados lá.
const CLOUDFLARE_COMMANDS_URL = process.env.CLOUDFLARE_COMMANDS_URL ||
  "https://sugarsmp-ticket-bot.nicolinhasni2401.workers.dev/register-commands";
const CLOUDFLARE_SETUP_SECRET = process.env.CLOUDFLARE_SETUP_SECRET || "";
const COMMAND_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
let commandSyncRunning = false;

async function syncCloudflareCommands() {
  if (!CLOUDFLARE_SETUP_SECRET) {
    console.log("[COMANDOS] Sincronização desativada: configure CLOUDFLARE_SETUP_SECRET no Railway.");
    return;
  }
  if (commandSyncRunning) return;
  commandSyncRunning = true;
  try {
    const response = await fetch(CLOUDFLARE_COMMANDS_URL, {
      method: "POST",
      headers: { "x-setup-secret": CLOUDFLARE_SETUP_SECRET },
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      console.error(`[COMANDOS] Falha no registro (${response.status}):`, result.error || "resposta inesperada");
      return;
    }
    console.log("[COMANDOS] Registrados pelo Cloudflare:",
      (result.commands || []).map((command) => command.name).join(", "));
  } catch (error) {
    console.error("[COMANDOS] Cloudflare indisponível:", error.message);
  } finally {
    commandSyncRunning = false;
  }
}

const inviteCache = new Map();
const vanityCache = new Map();
const recentLeaveHandled = new Map();

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

async function fetchVanityData(guild) {
  try {
    const response = await fetch(`https://discord.com/api/v10/guilds/${guild.id}/vanity-url`, {
      headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` },
    });

    // Servidores sem vanity URL podem responder sem código configurado.
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn(`[VANITY] Não consegui consultar o link personalizado (${response.status}): ${detail}`);
      return null;
    }

    const data = await response.json();
    const result = {
      code: data?.code || null,
      uses: Number(data?.uses || 0),
    };

    vanityCache.set(guild.id, result);
    return result;
  } catch (error) {
    console.error(`[VANITY] Erro consultando vanity URL de ${guild.name}:`, error);
    return null;
  }
}

function detectUsedVanity(before, after) {
  if (!before || !after || !after.code) return null;
  if (Number(after.uses || 0) <= Number(before.uses || 0)) return null;

  return {
    code: after.code,
    uses: after.uses,
    vanity: true,
    inviterId: null,
    inviterTag: "Astral MC",
  };
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

  const inviterText = inviteInfo?.vanity
    ? `<@${CONFIG.BOT_USER_ID}>`
    : inviteInfo?.inviterId
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
    .setImage("attachment://astralbanner.png")
    .setFooter({ text: "Astral MC • Seja bem-vindo!" })
    .setTimestamp();

  const payload = {
    content: `<@${member.id}>`,
    embeds: [embed],
    allowedMentions: { users: [member.id] },
  };

  if (fs.existsSync(CONFIG.WELCOME_BANNER_FILE)) {
    payload.files = [
      { attachment: CONFIG.WELCOME_BANNER_FILE, name: "astralbanner.png" },
    ];
  } else {
    // Se o arquivo não estiver no repositório, remove a imagem para a mensagem não falhar.
    embed.setImage(null);
  }

  await channel.send(payload);
}

async function sendLeave(member, savedInvite) {
  if (!CONFIG.LEAVE_CHANNEL_ID) {
    console.warn("[LEAVE] LEAVE_CHANNEL_ID não configurado.");
    return false;
  }

  let channel = member.guild.channels.cache.get(CONFIG.LEAVE_CHANNEL_ID) || null;
  if (!channel) {
    channel = await member.guild.channels.fetch(CONFIG.LEAVE_CHANNEL_ID).catch((error) => {
      console.error("[LEAVE] Não consegui buscar o canal de saída:", error);
      return null;
    });
  }

  if (!channel || !channel.isTextBased()) {
    console.error(`[LEAVE] Canal de saída inválido ou não é de texto: ${CONFIG.LEAVE_CHANNEL_ID}`);
    return false;
  }

  const inviterText = savedInvite?.sourceType === "vanity"
    ? `<@${CONFIG.BOT_USER_ID}>`
    : savedInvite?.inviterId
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

  const sent = await channel.send({
    embeds: [embed],
    // Mostra as menções clicáveis sem disparar ping.
    allowedMentions: { parse: [], users: [] },
  });

  console.log(`[LEAVE] Mensagem de saída enviada para #${channel.name} (${sent.id}).`);
  return true;
}

async function sendInviteLog(member, inviteInfo) {
  if (!CONFIG.INVITE_LOG_CHANNEL_ID) return;

  const channel = await member.guild.channels.fetch(CONFIG.INVITE_LOG_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const inviterText = inviteInfo?.vanity
    ? `<@${CONFIG.BOT_USER_ID}> **(link personalizado)**`
    : inviteInfo?.inviterId
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

  void syncCloudflareCommands();
  setInterval(() => void syncCloudflareCommands(), COMMAND_SYNC_INTERVAL_MS).unref();

  for (const guild of client.guilds.cache.values()) {
    await fetchGuildInvites(guild);
    await fetchVanityData(guild);
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
    const beforeInvites = inviteCache.get(member.guild.id) || new Map();
    const beforeVanity = vanityCache.get(member.guild.id) || null;

    const afterInvites = await fetchGuildInvites(member.guild);
    const afterVanity = await fetchVanityData(member.guild);

    let usedInvite = detectUsedInvite(beforeInvites, afterInvites);

    // O link personalizado (vanity URL) pertence ao servidor, não a um usuário.
    // Se o contador dele subir, mostramos "Astral MC" como origem da entrada.
    if (!usedInvite) {
      usedInvite = detectUsedVanity(beforeVanity, afterVanity);
    }

    const record = {
      memberId: member.id,
      username: member.user.tag,
      inviterId: usedInvite?.inviterId || null,
      inviterTag: usedInvite?.inviterTag || null,
      inviteCode: usedInvite?.code || null,
      sourceType: usedInvite?.vanity ? "vanity" : (usedInvite ? "invite" : "unknown"),
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


function markLeaveHandled(userId) {
  recentLeaveHandled.set(userId, Date.now());
  setTimeout(() => recentLeaveHandled.delete(userId), 10_000).unref?.();
}

function wasLeaveHandled(userId) {
  const when = recentLeaveHandled.get(userId);
  return !!when && (Date.now() - when) < 10_000;
}

async function handleMemberLeave(member, source = "normal") {
  if (!member?.id || wasLeaveHandled(member.id)) return;

  markLeaveHandled(member.id);
  console.log(`[LEAVE EVENT:${source}] ${member.user?.tag || member.id} (${member.id}) saiu do servidor.`);

  try {
    const savedInvite = inviteDb[member.id] || null;
    await sendLeave(member, savedInvite);
  } catch (error) {
    console.error(`[LEAVE:${source}] Erro processando saída:`, error);
  }
}

client.on(Events.GuildMemberRemove, async (member) => {
  await handleMemberLeave(member, "guildMemberRemove");
});

// Fallback de baixo nível.
// Em alguns cenários o evento normal do discord.js pode não chegar como esperado
// por estado de cache. O pacote RAW ainda contém GUILD_MEMBER_REMOVE.
// Esperamos um pouco e só enviamos se o evento normal não tiver sido tratado.
client.on(Events.Raw, async (packet) => {
  if (packet?.t !== "GUILD_MEMBER_REMOVE") return;

  const data = packet.d || {};
  const userId = data.user?.id;
  const guildId = data.guild_id;
  if (!userId || !guildId) return;

  setTimeout(async () => {
    if (wasLeaveHandled(userId)) return;

    try {
      const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId);
      const user = client.users.cache.get(userId) || await client.users.fetch(userId);

      const savedInvite = inviteDb[userId] || null;
      const joinedAt = savedInvite?.joinedAt ? new Date(savedInvite.joinedAt) : null;

      const pseudoMember = {
        id: userId,
        guild,
        user,
        joinedAt,
      };

      await handleMemberLeave(pseudoMember, "raw-fallback");
    } catch (error) {
      console.error("[LEAVE:raw-fallback] Falha no fallback de saída:", error);
    }
  }, 1200);
});

client.on("error", console.error);

app.get("/", (req, res) => {
  res.json({
    ok: true,
    bot: "Astral MC Gateway Bot",
    status: client.isReady() ? "online" : "connecting",
    features: {
      inviteTracking: true,
      vanityTracking: true,
      welcomeBanner: fs.existsSync(CONFIG.WELCOME_BANNER_FILE),
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
