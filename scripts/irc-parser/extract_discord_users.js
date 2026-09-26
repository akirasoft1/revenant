// Extract Discord users from a specific channel
// Run with: node extract_discord_users.js <channelId> [outputFile]
// Example: node extract_discord_users.js 684882379516805202 discord_users.json

const fs = require('fs');
const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config({ path: '../../.env', quiet: true });

const CHANNEL_ID = process.argv[2] || '684882379516805202';
const OUTPUT_FILE = process.argv[3] || 'discord_users.json';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ]
});

client.once('ready', async () => {
  console.error(`Logged in as ${client.user.tag}`);
  
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) {
      console.error(`Channel ${CHANNEL_ID} not found`);
      process.exit(1);
    }
    
    const guild = channel.guild;
    console.error(`Channel: #${channel.name} in ${guild.name}`);
    
    // Fetch all members who have access to this channel
    await guild.members.fetch();
    
    const members = guild.members.cache.filter(member => 
      channel.permissionsFor(member).has('ViewChannel')
    );
    
    console.error(`Found ${members.size} members with access to #${channel.name}`);

    // Output as JSON
    const users = members.map(m => ({
      discordId: m.user.id,
      username: m.user.username,
      displayName: m.displayName,
      globalName: m.user.globalName,
      joinedAt: m.joinedAt?.toISOString(),
    }));

    // Write to file to avoid dotenvx stdout pollution
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(users, null, 2));
    console.error(`Wrote ${users.length} users to ${OUTPUT_FILE}`);
    
  } catch (error) {
    console.error('Error:', error.message);
  }
  
  client.destroy();
});

client.login(process.env.DISCORD_TOKEN);
