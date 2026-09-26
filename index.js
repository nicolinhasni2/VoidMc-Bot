const { Client, GatewayIntentBits, ActivityType } = require("discord.js");
const express = require("express");

const app = express();

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("🌑 VoidMc Bot está funcionando!");
});

app.listen(PORT, () => {
  console.log(`Servidor web iniciado na porta ${PORT}`);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ]
});

client.once("clientReady", () => {
  console.log("----------------------------------");
  console.log("✅ Bot conectado!");
  console.log(`🤖 Nome: ${client.user.tag}`);
  console.log(`🆔 ID: ${client.user.id}`);
  console.log("----------------------------------");

  client.user.setPresence({
    activities: [
      {
        name: "🌑 VoidMc",
        type: ActivityType.Watching
      }
    ],
    status: "online"
  });
});

client.on("error", console.error);

client.login(process.env.DISCORD_TOKEN);