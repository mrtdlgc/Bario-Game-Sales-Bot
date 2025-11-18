import dotenv from "dotenv";
import { ethers } from "ethers";
import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import * as cheerio from "cheerio";
import pkg from "pg";
const { Pool } = pkg;

dotenv.config();

// --- Setup ---
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL, {
  chainId: 8453, // Base mainnet
  name: "base"
});
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const FACTORY = process.env.FACTORY_ADDRESS.toLowerCase();

// Parse chat destinations (supports multiple chats and topics)
// Format: TELEGRAM_CHAT_ID=-123456 or -123456:789 (chat:topic) or multiple: -123,@channel,-456:123
const CHAT_DESTINATIONS = [];
if (process.env.TELEGRAM_CHAT_ID) {
  const chatIds = process.env.TELEGRAM_CHAT_ID.split(',').map(c => c.trim());
  chatIds.forEach(chatConfig => {
    if (chatConfig.includes(':')) {
      // Format: chatId:topicId
      const [chatId, topicId] = chatConfig.split(':');
      CHAT_DESTINATIONS.push({ 
        chatId: chatId.trim(), 
        topicId: parseInt(topicId.trim()) 
      });
    } else {
      // Just chatId
      CHAT_DESTINATIONS.push({ 
        chatId: chatConfig, 
        topicId: null 
      });
    }
  });
}

console.log(`📢 Configured ${CHAT_DESTINATIONS.length} notification destination(s)`);

// Admin user IDs who can use admin commands like /updatelinks and /setlink
const ADMIN_USER_IDS = process.env.ADMIN_USER_IDS 
  ? process.env.ADMIN_USER_IDS.split(',').map(id => parseInt(id.trim()))
  : [];

if (ADMIN_USER_IDS.length > 0) {
  console.log(`🔐 Configured ${ADMIN_USER_IDS.length} admin user(s)`);
} else {
  console.log(`⚠️ No ADMIN_USER_IDS set - admin commands are unrestricted!`);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- DB Setup ---
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cartridges (
      address TEXT PRIMARY KEY,
      title TEXT,
      game_link TEXT,
      genre TEXT,
      image TEXT,
      ipfs TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      topic_id INTEGER,
      chat_title TEXT,
      chat_type TEXT,
      subscribed_by_id BIGINT,
      subscribed_by_name TEXT,
      subscribed_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(chat_id, topic_id)
    );
  `);
  
  console.log("🗄️ Database initialized");
}

async function saveCartridge(data) {
  const { cartridge, title, gameLink, genre, img, ipfs } = data;
  await pool.query(
    `
    INSERT INTO cartridges (address, title, game_link, genre, image, ipfs)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (address) DO NOTHING;
  `,
    [cartridge, title, gameLink || null, genre, img, ipfs]
  );
}

async function updateGameLink(address, gameLink) {
  await pool.query(
    `UPDATE cartridges SET game_link = $1 WHERE LOWER(address) = LOWER($2)`,
    [gameLink, address]
  );
}

async function updateGameTitle(address, title) {
  await pool.query(
    `UPDATE cartridges SET title = $1 WHERE LOWER(address) = LOWER($2)`,
    [title, address]
  );
}

async function loadCartridges() {
  const res = await pool.query("SELECT address FROM cartridges");
  return res.rows.map((r) => r.address.toLowerCase());
}

async function getAllCartridges() {
  const res = await pool.query("SELECT * FROM cartridges ORDER BY created_at DESC");
  return res.rows;
}

async function getStats() {
  const res = await pool.query(`
    SELECT 
      COUNT(*) as total,
      COUNT(DISTINCT genre) as genres,
      genre,
      COUNT(*) as count
    FROM cartridges
    GROUP BY genre
    ORDER BY count DESC
  `);
  return res.rows;
}

// --- Subscription Management ---
async function addSubscription(chatId, topicId, chatTitle, chatType, userId, userName) {
  await pool.query(
    `INSERT INTO subscriptions (chat_id, topic_id, chat_title, chat_type, subscribed_by_id, subscribed_by_name)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (chat_id, topic_id) DO UPDATE SET
       chat_title = EXCLUDED.chat_title,
       subscribed_at = NOW()`,
    [chatId.toString(), topicId, chatTitle, chatType, userId, userName]
  );
}

async function removeSubscription(chatId, topicId) {
  await pool.query(
    `DELETE FROM subscriptions WHERE chat_id = $1 AND topic_id IS NOT DISTINCT FROM $2`,
    [chatId.toString(), topicId]
  );
}

async function getSubscriptions() {
  const res = await pool.query(
    `SELECT chat_id, topic_id, chat_title, chat_type FROM subscriptions ORDER BY subscribed_at DESC`
  );
  return res.rows;
}

async function isSubscribed(chatId, topicId) {
  const res = await pool.query(
    `SELECT 1 FROM subscriptions WHERE chat_id = $1 AND topic_id IS NOT DISTINCT FROM $2`,
    [chatId.toString(), topicId]
  );
  return res.rows.length > 0;
}

// Helper to check if user is admin in the chat
async function isUserAdmin(chatId, userId) {
  try {
    const member = await bot.getChatMember(chatId, userId);
    return ['creator', 'administrator'].includes(member.status);
  } catch (e) {
    console.error('Error checking admin status:', e.message);
    return false;
  }
}

// Helper to check if user is in the admin whitelist
function isWhitelistedAdmin(userId) {
  if (ADMIN_USER_IDS.length === 0) {
    // If no admins configured, allow all (backward compatibility)
    console.log('⚠️ No admin whitelist configured - allowing command');
    return true;
  }
  return ADMIN_USER_IDS.includes(userId);
}

// --- Helpers ---
function decodeUtf8(hex) {
  try {
    return Buffer.from(hex.replace(/^0x/, ""), "hex").toString("utf8");
  } catch {
    return "";
  }
}

// Get contract name and symbol
async function getContractInfo(contractAddress) {
  try {
    const contractABI = [
      "function name() view returns (string)",
      "function symbol() view returns (string)"
    ];
    const contract = new ethers.Contract(contractAddress, contractABI, provider);
    
    const [name, symbol] = await Promise.all([
      contract.name(),
      contract.symbol()
    ]);
    
    // Extract just the game name (before " - Baes Game Cartridge")
    const gameName = name.replace(/\s*-\s*Baes Game Cartridge\s*$/i, '').trim();
    
    return { name: gameName, symbol, fullName: name, success: true };
  } catch (err) {
    console.log(`⚠️ Could not read contract ${contractAddress.substring(0, 10)}... - will use fallback`);
    return { name: null, symbol: null, fullName: null, success: false };
  }
}

function parseMetadata(hexData) {
  const utf8 = decodeUtf8(hexData);
  
  // Extract title from transaction data as fallback
  let title = "Unknown Game";
  // Look for game name pattern: [binary]GameName - Baes or similar
  const titlePatterns = [
    /([A-Z][A-Za-z0-9\s]{3,40})\s*-\s*Baes/,  // "Game Name - Baes"
    /@([A-Z][A-Za-z0-9\s]{3,40})[^\x20-\x7E]/,  // After @ symbol
    /\s([A-Z][A-Za-z0-9\s]{3,40})\s*[A-Z]{2,5}\s/,  // "Game Name SYMBOL"
  ];
  
  for (const pattern of titlePatterns) {
    const match = utf8.match(pattern);
    if (match && match[1]) {
      title = match[1].trim();
      break;
    }
  }

  // Extract genre - lowercase word before https://
  const genreMatch = utf8.match(/([a-z]{4,})https?:/i);
  const genre = genreMatch ? genreMatch[1] : "Unknown";

  // Extract image URL
  const imgMatch = utf8.match(/https?:\/\/[^\x00\s]+\.(?:png|jpg|jpeg|gif)/i);
  const img = imgMatch ? imgMatch[0] : null;

  // Extract IPFS URL
  const ipfsMatch = utf8.match(/ipfs:\/\/[^\x00\s]+/);
  const ipfs = ipfsMatch ? ipfsMatch[0] : null;

  return { title, genre, img, ipfs };
}

// Helper function to send to all configured destinations
async function sendToAllChats(messageOrPhoto, options = {}) {
  const { isPhoto = false, imageUrl = null, caption = null, text = null } = options;
  
  // Get destinations from database
  const dbSubscriptions = await getSubscriptions();
  const destinations = dbSubscriptions.map(sub => ({
    chatId: sub.chat_id,
    topicId: sub.topic_id
  }));
  
  // Add ENV-configured destinations as fallback (if any)
  if (CHAT_DESTINATIONS.length > 0) {
    destinations.push(...CHAT_DESTINATIONS);
  }
  
  if (destinations.length === 0) {
    console.log('⚠️ No subscribers or ENV destinations configured');
    return;
  }
  
  for (const destination of destinations) {
    try {
      const sendOptions = {
        parse_mode: "Markdown",
        ...(destination.topicId && { message_thread_id: destination.topicId })
      };
      
      if (isPhoto && imageUrl) {
        await bot.sendPhoto(destination.chatId, imageUrl, {
          ...sendOptions,
          caption: caption || text
        });
      } else {
        await bot.sendMessage(destination.chatId, text || caption, sendOptions);
      }
    } catch (e) {
      console.error(`❌ Error sending to ${destination.chatId}${destination.topicId ? ':' + destination.topicId : ''}:`, e.message);
    }
  }
}

async function sendTelegramWithImage({ title, genre, img, ipfs, cartridge, gameLink }) {
  const caption = `🎮 *${title}*\n🕹 Genre: ${genre}\n💾 Contract: \`${cartridge}\`${gameLink ? `\n🔗 [Play on Bario](${gameLink})` : ''}\n\n${ipfs ? `🪣 ${ipfs}` : ""}`;
  const imageUrl = img || (ipfs ? ipfs.replace("ipfs://", "https://ipfs.io/ipfs/") : null);

  await sendToAllChats(null, {
    isPhoto: !!imageUrl,
    imageUrl: imageUrl,
    caption: caption,
    text: caption
  });
}

// --- Automated Link Updater (using sitemap.xml) ---
async function updateBaesLinks() {
  const results = {
    total: 0,
    updated: 0,
    skipped: 0,
    titlesUpdated: 0,
    notFound: 0,
    errors: []
  };

  try {
    console.log("🔍 Fetching sitemap from baes.app...");
    
    // Fetch sitemap.xml
    const sitemapResponse = await axios.get("https://baes.app/sitemap.xml", {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BarioBot/1.0)'
      }
    });
    
    const $ = cheerio.load(sitemapResponse.data, { xmlMode: true });
    const gameLinks = [];
    
    // Parse sitemap URLs - look for /game/ paths
    $('url loc').each((i, elem) => {
      const url = $(elem).text();
      if (url && url.includes('/game/')) {
        gameLinks.push(url);
      }
    });
    
    console.log(`📀 Found ${gameLinks.length} game pages in sitemap`);
    results.total = gameLinks.length;
    
    // Get all cartridges from database
    const dbCartridges = await pool.query("SELECT address, title, game_link FROM cartridges");
    const cartridgeMap = new Map();
    dbCartridges.rows.forEach(row => {
      cartridgeMap.set(row.address.toLowerCase(), {
        title: row.title,
        gameLink: row.game_link
      });
    });
    
    // Process each game page
    for (const gameUrl of gameLinks) {
      try {
        // Small delay to be respectful
        await new Promise(resolve => setTimeout(resolve, 300));
        
        console.log(`📄 Fetching: ${gameUrl}`);
        
        const gamePage = await axios.get(gameUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; BarioBot/1.0)'
          },
          timeout: 10000
        });
        
        const game$ = cheerio.load(gamePage.data);
        const htmlContent = gamePage.data;
        
        // Extract contract address from the page
        let contractAddress = null;
        let gameTitle = null;
        
        // Method 1: Search for "contract_address":"0x..." and "title":"..." pattern directly in HTML
        // Handle both regular JSON and escaped JSON (from Next.js streaming)
        const contractPatterns = [
          /"contract_address"\s*:\s*"(0x[a-fA-F0-9]{40})"/,           // Regular JSON
          /\\"contract_address\\":\\"(0x[a-fA-F0-9]{40})\\"/,          // Escaped JSON
          /contract_address["\s:]+([0x][a-fA-F0-9]{40})/,              // Flexible pattern
        ];
        
        const titlePatterns = [
          /"title"\s*:\s*"([^"]+)"/,                                   // Regular JSON
          /\\"title\\":\\"([^\\]+)\\"/,                                // Escaped JSON
        ];
        
        for (const pattern of contractPatterns) {
          const match = htmlContent.match(pattern);
          if (match) {
            contractAddress = match[1].toLowerCase();
            console.log(`   Found contract in HTML: ${contractAddress}`);
            break;
          }
        }
        
        // Extract title from the same JSON data
        for (const pattern of titlePatterns) {
          const match = htmlContent.match(pattern);
          if (match) {
            gameTitle = match[1];
            // Clean up escaped characters
            gameTitle = gameTitle.replace(/\\u003c/g, '<')
                                 .replace(/\\u003e/g, '>')
                                 .replace(/\\\\/g, '\\')
                                 .replace(/\\"/g, '"');
            console.log(`   Found title: ${gameTitle}`);
            break;
          }
        }
        
        // Method 2: If not found, try parsing __NEXT_DATA__ script
        if (!contractAddress) {
          const nextDataScript = game$('script#__NEXT_DATA__').html();
          if (nextDataScript) {
            try {
              const nextData = JSON.parse(nextDataScript);
              
              // Recursively search for contract_address in the JSON
              const findContractAddress = (obj) => {
                if (obj && typeof obj === 'object') {
                  if (obj.contract_address && typeof obj.contract_address === 'string' && obj.contract_address.startsWith('0x')) {
                    return obj.contract_address;
                  }
                  for (const key in obj) {
                    const result = findContractAddress(obj[key]);
                    if (result) return result;
                  }
                }
                return null;
              };
              
              const found = findContractAddress(nextData);
              if (found) {
                contractAddress = found.toLowerCase();
                console.log(`   Found contract in __NEXT_DATA__: ${contractAddress}`);
              }
            } catch (parseErr) {
              console.log(`   ⚠️ Error parsing __NEXT_DATA__: ${parseErr.message}`);
            }
          }
        }
        
        // Method 3: Fallback to checking for Basescan links in HTML
        if (!contractAddress) {
          game$('a[href*="basescan.org"]').each((i, elem) => {
            const href = game$(elem).attr('href');
            if (href) {
              const addressMatch = href.match(/\/(?:address|token)\/(0x[a-fA-F0-9]{40})/);
              if (addressMatch && !contractAddress) {
                contractAddress = addressMatch[1].toLowerCase();
                console.log(`   Found contract in Basescan link: ${contractAddress}`);
              }
            }
          });
        }
        
        if (contractAddress && cartridgeMap.has(contractAddress)) {
          const cartridgeData = cartridgeMap.get(contractAddress);
          const currentTitle = cartridgeData.title;
          const existingLink = cartridgeData.gameLink;
          
          // Only update the game link if it doesn't already exist
          if (!existingLink) {
            await updateGameLink(contractAddress, gameUrl);
            results.updated++;
            console.log(`✅ Updated link: ${currentTitle} -> ${gameUrl}`);
          } else {
            results.skipped++;
            console.log(`⏭️ Skipped: ${currentTitle} already has link ${existingLink}`);
          }
          
          // Update the game title if we found a better one
          if (gameTitle && gameTitle !== currentTitle) {
            await updateGameTitle(contractAddress, gameTitle);
            results.titlesUpdated++;
            console.log(`✅ Updated title: "${currentTitle}" → "${gameTitle}"`);
          }
          
        } else if (contractAddress) {
          results.notFound++;
          console.log(`⚠️ Contract ${contractAddress} not in our database (game: ${gameUrl})`);
        } else {
          console.log(`   ❌ Could not find contract address on this page`);
        }
        
      } catch (err) {
        results.errors.push(`Error processing ${gameUrl}: ${err.message}`);
        console.error(`❌ Error processing ${gameUrl}:`, err.message);
      }
    }
    
  } catch (err) {
    results.errors.push(`Main error: ${err.message}`);
    console.error("❌ Error fetching sitemap:", err.message);
  }
  
  return results;
}

// --- Auto-Update Scheduler ---
async function startAutoUpdater() {
  // Run on startup
  console.log("🔄 Running initial link sync...");
  try {
    const results = await updateBaesLinks();
    console.log(`✅ Startup sync complete: ${results.updated} links updated, ${results.skipped} skipped (already set), ${results.titlesUpdated} titles corrected`);
  } catch (err) {
    console.error("❌ Startup sync failed:", err.message);
  }
  
  // Run every 24 hours
  setInterval(async () => {
    console.log("🔄 Running scheduled link update...");
    try {
      const results = await updateBaesLinks();
      
      // Log results to console (no Telegram notification)
      if (results.updated > 0 || results.titlesUpdated > 0) {
        console.log(`✅ Scheduled update complete: ${results.updated} link(s) updated, ${results.skipped} skipped (already set), ${results.titlesUpdated} title(s) corrected`);
      } else {
        console.log(`✅ Scheduled update complete: No changes needed (${results.skipped} already had links)`);
      }
    } catch (err) {
      console.error("❌ Scheduled update failed:", err.message);
    }
  }, 24 * 60 * 60 * 1000); // 24 hours
}

// --- Telegram Commands ---
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `🎮 *Welcome to Bario Sales Bot!*\n\nI'm monitoring the GemBario factory for:\n\n📀 New game cartridges deployed\n💰 Sales transactions\n\n*Available Commands:*\n/subscribe - Start receiving notifications (admins only)\n/unsubscribe - Stop notifications (admins only)\n/subscribers - View all subscriptions\n/list - View all tracked cartridges\n/stats - View tracking statistics\n/latest - Show most recent cartridge\n/myid - Get your user ID\n/help - Show all commands\n\nYou're all set! 🚀`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `🤖 *Bario Sales Bot Commands*\n\n*Subscription Management:*\n/subscribe - Start receiving notifications (admins only)\n/unsubscribe - Stop notifications (admins only)\n/subscribers - View all subscriptions\n\n*Information:*\n/list - View all tracked cartridges\n/stats - View tracking statistics\n/latest - Show most recent cartridge\n\n*Admin Tools:*\n/setlink - Add/update game link (whitelisted admins only)\n/updatelinks - Auto-update all game links (whitelisted admins only)\n/chatid - Get this chat's ID\n/myid - Get your user ID\n\n*Help:*\n/start - Welcome message\n/help - Show this message\n\n📡 Factory: \`${FACTORY}\``,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/chatid/, (msg) => {
  const chatId = msg.chat.id;
  const chatType = msg.chat.type;
  const chatTitle = msg.chat.title || "Private Chat";
  const threadId = msg.message_thread_id; // Topic ID if in a forum/topic
  
  let message = `📋 *Chat Information*\n\nChat ID: \`${chatId}\`\nType: ${chatType}\nTitle: ${chatTitle}\n`;
  
  if (threadId) {
    message += `\n🧵 *Topic/Thread ID*: \`${threadId}\`\n`;
    message += `\n_This message was sent in a topic. Use both Chat ID and Topic ID together!_\n`;
  }
  
  message += `\n_Copy the IDs above for your .env file_`;
  
  bot.sendMessage(
    chatId,
    message,
    { 
      parse_mode: "Markdown",
      message_thread_id: threadId // Reply in the same topic
    }
  );
});

bot.onText(/\/myid/, (msg) => {
  const userId = msg.from.id;
  const userName = msg.from.username || msg.from.first_name || 'Unknown';
  const chatId = msg.chat.id;
  
  bot.sendMessage(
    chatId,
    `👤 *Your User Information*\n\nUser ID: \`${userId}\`\nUsername: @${userName}\n\n_Use this ID for ADMIN_USER_IDS in .env_`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/subscribe/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userName = msg.from.username || msg.from.first_name || 'Unknown';
  const chatType = msg.chat.type;
  const chatTitle = msg.chat.title || 'Private Chat';
  const topicId = msg.message_thread_id || null;
  
  // Check if user is admin
  const isAdmin = await isUserAdmin(chatId, userId);
  
  if (!isAdmin) {
    return bot.sendMessage(
      chatId,
      "⛔ Only administrators can subscribe this chat to notifications.",
      { parse_mode: "Markdown", message_thread_id: topicId }
    );
  }
  
  // Check if already subscribed
  const alreadySubscribed = await isSubscribed(chatId, topicId);
  
  if (alreadySubscribed) {
    return bot.sendMessage(
      chatId,
      "✅ This chat is already subscribed to notifications!",
      { parse_mode: "Markdown", message_thread_id: topicId }
    );
  }
  
  // Add subscription
  await addSubscription(chatId, topicId, chatTitle, chatType, userId, userName);
  
  let confirmMsg = `✅ *Subscription Added!*\n\n`;
  confirmMsg += `This ${topicId ? 'topic' : 'chat'} will now receive:\n`;
  confirmMsg += `🎮 New cartridge deployments\n`;
  confirmMsg += `💰 Sale notifications\n\n`;
  confirmMsg += `Use /unsubscribe to stop notifications`;
  
  bot.sendMessage(chatId, confirmMsg, { 
    parse_mode: "Markdown",
    message_thread_id: topicId
  });
});

bot.onText(/\/unsubscribe/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const topicId = msg.message_thread_id || null;
  
  // Check if user is admin
  const isAdmin = await isUserAdmin(chatId, userId);
  
  if (!isAdmin) {
    return bot.sendMessage(
      chatId,
      "⛔ Only administrators can unsubscribe this chat from notifications.",
      { parse_mode: "Markdown", message_thread_id: topicId }
    );
  }
  
  // Check if subscribed
  const subscribed = await isSubscribed(chatId, topicId);
  
  if (!subscribed) {
    return bot.sendMessage(
      chatId,
      "❌ This chat is not subscribed to notifications.",
      { parse_mode: "Markdown", message_thread_id: topicId }
    );
  }
  
  // Remove subscription
  await removeSubscription(chatId, topicId);
  
  bot.sendMessage(
    chatId,
    `✅ Unsubscribed! This ${topicId ? 'topic' : 'chat'} will no longer receive notifications.\n\nUse /subscribe to re-enable.`,
    { parse_mode: "Markdown", message_thread_id: topicId }
  );
});

bot.onText(/\/subscribers/, async (msg) => {
  const chatId = msg.chat.id;
  
  try {
    const subscriptions = await getSubscriptions();
    
    if (subscriptions.length === 0) {
      return bot.sendMessage(chatId, "📭 No active subscriptions.", { parse_mode: "Markdown" });
    }
    
    let message = `📢 *Active Subscriptions* (${subscriptions.length}):\n\n`;
    
    subscriptions.forEach((sub, index) => {
      const location = sub.topic_id 
        ? `${sub.chat_title} (Topic ${sub.topic_id})`
        : sub.chat_title;
      message += `${index + 1}. ${location}\n`;
      message += `   ID: \`${sub.chat_id}\`\n`;
      message += `   Type: ${sub.chat_type}\n\n`;
    });
    
    // Also show ENV-configured destinations
    if (CHAT_DESTINATIONS.length > 0) {
      message += `\n📌 *ENV Destinations* (${CHAT_DESTINATIONS.length}):\n\n`;
      CHAT_DESTINATIONS.forEach((dest, index) => {
        message += `${index + 1}. ${dest.chatId}${dest.topicId ? ':' + dest.topicId : ''}\n`;
      });
    }
    
    bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  } catch (e) {
    bot.sendMessage(chatId, "❌ Error fetching subscriptions: " + e.message);
  }
});

// Admin command to manually set a game link
bot.onText(/\/setlink(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const args = match[1]?.trim();
  
  // Check admin whitelist
  if (!isWhitelistedAdmin(userId)) {
    return bot.sendMessage(
      chatId,
      "⛔ You are not authorized to use this command. Contact the bot administrator.",
      { parse_mode: "Markdown" }
    );
  }
  
  if (!args) {
    return bot.sendMessage(
      chatId,
      "Usage: `/setlink <contract_address> <game_url>`\n\nExample:\n`/setlink 0x1234...5678 https://baes.app/game/my-game`",
      { parse_mode: "Markdown" }
    );
  }
  
  const parts = args.split(/\s+/);
  if (parts.length < 2) {
    return bot.sendMessage(
      chatId,
      "❌ Please provide both contract address and game URL",
      { parse_mode: "Markdown" }
    );
  }
  
  const [address, gameUrl] = parts;
  
  try {
    // Verify cartridge exists
    const cartridge = await pool.query(
      "SELECT address, title FROM cartridges WHERE LOWER(address) = LOWER($1)",
      [address]
    );
    
    if (cartridge.rows.length === 0) {
      return bot.sendMessage(
        chatId,
        `❌ Cartridge \`${address}\` not found in database`,
        { parse_mode: "Markdown" }
      );
    }
    
    // Update the link
    await updateGameLink(address, gameUrl);
    
    const title = cartridge.rows[0].title;
    bot.sendMessage(
      chatId,
      `✅ Updated link for *${title}*\n\n🔗 ${gameUrl}`,
      { parse_mode: "Markdown" }
    );
    
    console.log(`✅ Manual link update by user ${userId}: ${title} -> ${gameUrl}`);
  } catch (e) {
    bot.sendMessage(chatId, "❌ Error updating link: " + e.message);
  }
});

// Admin command to trigger link update
bot.onText(/\/updatelinks/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  // Check admin whitelist
  if (!isWhitelistedAdmin(userId)) {
    return bot.sendMessage(
      chatId,
      "⛔ You are not authorized to use this command. Contact the bot administrator.",
      { parse_mode: "Markdown" }
    );
  }
  
  bot.sendMessage(chatId, "🔄 Starting link update... This may take a few minutes.", { parse_mode: "Markdown" });
  
  try {
    const results = await updateBaesLinks();
    
    let message = `✅ *Update Complete!*\n\n`;
    message += `📊 Scanned: ${results.total} game pages\n`;
    message += `✅ Updated: ${results.updated} game links\n`;
    message += `⏭️ Skipped: ${results.skipped} (already set)\n`;
    message += `📝 Titles corrected: ${results.titlesUpdated}\n`;
    message += `⚠️ Not in DB: ${results.notFound}\n`;
    
    if (results.errors.length > 0) {
      message += `\n❌ Errors: ${results.errors.length}\n`;
      message += results.errors.slice(0, 3).map(e => `- ${e}`).join('\n');
      if (results.errors.length > 3) {
        message += `\n... and ${results.errors.length - 3} more`;
      }
    }
    
    bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
    console.log(`✅ Manual link update completed by user ${userId}`);
  } catch (e) {
    bot.sendMessage(chatId, "❌ Update failed: " + e.message);
  }
});

bot.onText(/\/list/, async (msg) => {
  const chatId = msg.chat.id;
  
  try {
    const cartridges = await getAllCartridges();
    
    if (cartridges.length === 0) {
      bot.sendMessage(chatId, "📭 No cartridges tracked yet!", { parse_mode: "Markdown" });
      return;
    }

    let message = `🎮 *Tracked Cartridges* (${cartridges.length}):\n\n`;
    
    cartridges.slice(0, 10).forEach((cart, i) => {
      message += `${i + 1}. *${cart.title}*\n`;
      message += `   🕹 ${cart.genre} | \`${cart.address.substring(0, 8)}...\`\n`;
      if (cart.game_link) {
        message += `   🔗 [Play on Bario](${cart.game_link})\n`;
      }
      message += `\n`;
    });

    if (cartridges.length > 10) {
      message += `\n_... and ${cartridges.length - 10} more_`;
    }

    bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  } catch (e) {
    bot.sendMessage(chatId, "❌ Error fetching cartridges: " + e.message);
  }
});

bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  
  try {
    const stats = await getStats();
    const total = stats.reduce((sum, s) => sum + parseInt(s.count), 0);
    
    let message = `📊 *Bario Bot Statistics*\n\n`;
    message += `🎮 Total Cartridges: ${total}\n`;
    message += `🏷 Genres: ${stats.length}\n\n`;
    message += `*Top Genres:*\n`;
    
    stats.slice(0, 5).forEach((s, i) => {
      message += `${i + 1}. ${s.genre}: ${s.count}\n`;
    });

    bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  } catch (e) {
    bot.sendMessage(chatId, "❌ Error fetching stats: " + e.message);
  }
});

bot.onText(/\/latest/, async (msg) => {
  const chatId = msg.chat.id;
  
  try {
    const cartridges = await getAllCartridges();
    
    if (cartridges.length === 0) {
      bot.sendMessage(chatId, "📭 No cartridges tracked yet!", { parse_mode: "Markdown" });
      return;
    }

    const latest = cartridges[0];
    const caption = `🎮 *${latest.title}* (Latest)\n\n🕹 Genre: ${latest.genre}\n💾 Contract: \`${latest.address}\`${latest.game_link ? `\n🔗 [Play on Bario](${latest.game_link})` : ''}\n\n${latest.ipfs ? `🪣 ${latest.ipfs}` : ""}`;
    
    const imageUrl = latest.image || (latest.ipfs ? latest.ipfs.replace("ipfs://", "https://ipfs.io/ipfs/") : null);

    if (imageUrl) {
      await bot.sendPhoto(chatId, imageUrl, {
        caption,
        parse_mode: "Markdown",
      });
    } else {
      await bot.sendMessage(chatId, caption, { parse_mode: "Markdown" });
    }
  } catch (e) {
    bot.sendMessage(chatId, "❌ Error fetching latest cartridge: " + e.message);
  }
});

bot.on("polling_error", (error) => {
  console.log("⚠️ Polling error:", error.message);
});

// --- Factory TX Handler ---
async function handleFactoryTx(tx) {
  if (!tx.data.startsWith("0x02a91f5e")) return;
  
  const receipt = await provider.waitForTransaction(tx.hash, 1);
  if (!receipt) return;

  let newContract = receipt.contractAddress || null;
  if (!newContract && receipt.logs.length) {
    for (const l of receipt.logs) {
      if (l.address && l.address !== FACTORY) {
        newContract = l.address;
        break;
      }
    }
  }

  if (!newContract) return;
  newContract = newContract.toLowerCase();

  // Parse metadata from transaction data
  const metadata = parseMetadata(tx.data);
  
  // Try to get contract name, fallback to parsed title if it fails
  const contractInfo = await getContractInfo(newContract);
  const title = contractInfo.success ? contractInfo.name : metadata.title;
  const symbol = contractInfo.symbol || "";
  
  console.log(`✅ New cartridge: ${title}${symbol ? ` (${symbol})` : ''} - ${metadata.genre}`);

  await saveCartridge({ 
    cartridge: newContract, 
    title, 
    gameLink: null, // Will be added manually via /setlink
    genre: metadata.genre, 
    img: metadata.img, 
    ipfs: metadata.ipfs 
  });
  
  await sendTelegramWithImage({ 
    title, 
    genre: metadata.genre, 
    img: metadata.img, 
    ipfs: metadata.ipfs, 
    cartridge: newContract,
    gameLink: null
  });
  
  // Add to tracking set
  cartridges.add(newContract);
}

// --- Cartridge TX Handler ---
// --- Load Existing ---
async function loadExistingCartridges() {
  const cartridges = new Set(await loadCartridges());
  console.log(`🧩 Loaded ${cartridges.size} cartridges from DB`);
  console.log(`✅ Skipping historical scan - monitoring NEW blocks only`);
  
  return cartridges;
}

// --- Main ---
await initDB();
const cartridges = await loadExistingCartridges();

// Load subscriptions
const dbSubscriptions = await getSubscriptions();
console.log(`📢 Loaded ${dbSubscriptions.length} subscription(s) from database`);
if (CHAT_DESTINATIONS.length > 0) {
  console.log(`📢 Plus ${CHAT_DESTINATIONS.length} ENV-configured destination(s)`);
}

// Start automatic link updater (runs on startup + every 24 hours)
await startAutoUpdater();

// Monitor confirmed blocks efficiently using eth_getLogs
let blockCount = 0;
let lastProcessedBlock = 0;
provider.on("block", async (blockNumber) => {
  try {
    blockCount++;
    
    // Skip if we already processed this block
    if (blockNumber <= lastProcessedBlock) return;
    lastProcessedBlock = blockNumber;
    
    // Log progress every 10 blocks
    if (blockCount % 10 === 0) {
      console.log(`✅ Monitoring active - block ${blockNumber} (${blockCount} processed)`);
    }
    
    // Use eth_getLogs to efficiently find transactions to our tracked addresses
    // This is MUCH faster than fetching all 300+ transactions individually
    const trackedAddresses = Array.from(cartridges);
    trackedAddresses.push(FACTORY); // Also watch factory
    
    try {
      const logs = await provider.getLogs({
        fromBlock: blockNumber,
        toBlock: blockNumber,
        address: trackedAddresses, // Only get logs from our tracked addresses
      });
      
      if (logs.length > 0) {
        console.log(`📦 Block ${blockNumber}: Found ${logs.length} logs from tracked addresses`);
        
        // Process each log - look for Transfer events (NFT mints)
        // Transfer event signature: Transfer(address,address,uint256)
        const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
        
        // Group mints by transaction hash to send a single notification per transaction
        const mintsByTransaction = new Map();
        
        for (const log of logs) {
          const contractAddr = log.address.toLowerCase();
          
          // Check if this is a Transfer event from a cartridge (mint)
          if (cartridges.has(contractAddr) && log.topics[0] === TRANSFER_TOPIC) {
            // Check if it's a mint (from address is 0x0)
            const fromAddr = log.topics[1]; // indexed 'from' parameter
            const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000000000000000000000000000";
            
            if (fromAddr === ZERO_ADDRESS) {
              // Group by transaction hash
              if (!mintsByTransaction.has(log.transactionHash)) {
                mintsByTransaction.set(log.transactionHash, []);
              }
              mintsByTransaction.get(log.transactionHash).push({
                contractAddr,
                txHash: log.transactionHash
              });
            }
          }
          
          // Check for new cartridge deployments
          if (contractAddr === FACTORY) {
            const tx = await provider.getTransaction(log.transactionHash);
            if (tx && tx.data && tx.data.startsWith("0x02a91f5e")) {
              console.log(`🎮 New cartridge deployment detected!`);
              handleFactoryTx(tx);
            }
          }
        }
        
        // Send consolidated notifications for mints
        for (const [txHash, mints] of mintsByTransaction) {
          const uniqueContracts = [...new Set(mints.map(m => m.contractAddr))];
          
          if (uniqueContracts.length === 1) {
            // Single cartridge, count how many were minted
            const mintCount = mints.length;
            console.log(`💸 ${mintCount} MINT(S) DETECTED in single transaction for ${uniqueContracts[0]}!`);
            
            try {
              const cartridgeInfo = await pool.query(
                "SELECT title, image, ipfs, game_link FROM cartridges WHERE LOWER(address) = LOWER($1)",
                [uniqueContracts[0]]
              );
              
              if (cartridgeInfo.rows.length === 0) {
                console.log(`⚠️ Cartridge ${uniqueContracts[0]} not found in database!`);
                continue;
              }
              
              const gameName = cartridgeInfo.rows[0]?.title || "Unknown Game";
              const img = cartridgeInfo.rows[0]?.image;
              const ipfs = cartridgeInfo.rows[0]?.ipfs;
              const gameLink = cartridgeInfo.rows[0]?.game_link;
              
              const imageUrl = img || (ipfs ? ipfs.replace("ipfs://", "https://ipfs.io/ipfs/") : null);
              
              // 🚀 HYPE SALES MESSAGE! 🚀
              let caption = `🚀 *${mintCount > 1 ? mintCount + ' CARTRIDGES' : 'NEW CARTRIDGE'} SOLD!* 🚀\n\n`;
              caption += `🎮 *${gameName}*\n`;
              if (gameLink) {
                caption += `🔗 [Play Now on BAES](${gameLink})\n`;
              }
              caption += `📜 [View Transaction](https://basescan.org/tx/${txHash})\n\n`;
              caption += `🔥 ${mintCount > 1 ? mintCount + ' collectors' : 'Another collector'} joined the game!`;
              
              await sendToAllChats(null, {
                isPhoto: !!imageUrl,
                imageUrl: imageUrl,
                caption: caption,
                text: caption
              });
              
              console.log(`✅ Sale notification sent for ${gameName} (${mintCount} mint${mintCount > 1 ? 's' : ''})`);
            } catch (dbErr) {
              console.error(`❌ Database error:`, dbErr.message);
            }
          } else {
            // Multiple different cartridges in one transaction (rare case)
            console.log(`💸 ${mints.length} MINTS DETECTED across ${uniqueContracts.length} cartridges in transaction ${txHash}!`);
            
            try {
              const gameNames = [];
              let firstImage = null;
              
              for (const contractAddr of uniqueContracts) {
                const cartridgeInfo = await pool.query(
                  "SELECT title, image, ipfs FROM cartridges WHERE LOWER(address) = LOWER($1)",
                  [contractAddr]
                );
                
                if (cartridgeInfo.rows.length > 0) {
                  const gameName = cartridgeInfo.rows[0]?.title || "Unknown Game";
                  const mintCountForGame = mints.filter(m => m.contractAddr === contractAddr).length;
                  gameNames.push(`${gameName}${mintCountForGame > 1 ? ` (×${mintCountForGame})` : ''}`);
                  
                  if (!firstImage) {
                    const img = cartridgeInfo.rows[0]?.image;
                    const ipfs = cartridgeInfo.rows[0]?.ipfs;
                    firstImage = img || (ipfs ? ipfs.replace("ipfs://", "https://ipfs.io/ipfs/") : null);
                  }
                }
              }
              
              let caption = `🚀 *${mints.length} CARTRIDGES SOLD!* 🚀\n\n`;
              caption += `🎮 ${gameNames.join(', ')}\n`;
              caption += `📜 [View Transaction](https://basescan.org/tx/${txHash})\n\n`;
              caption += `🔥 Multiple collectors joined the game!`;
              
              await sendToAllChats(null, {
                isPhoto: !!firstImage,
                imageUrl: firstImage,
                caption: caption,
                text: caption
              });
              
              console.log(`✅ Multi-cartridge sale notification sent (${mints.length} mints)`);
            } catch (dbErr) {
              console.error(`❌ Database error:`, dbErr.message);
            }
          }
        }
      }
    } catch (logsErr) {
      console.error(`⚠️ Error getting logs for block ${blockNumber}:`, logsErr.message);
    }
  } catch (err) {
    console.error(`⚠️ Error processing block ${blockNumber}:`, err.message);
  }
});

console.log("🤖 Bario Sales Bot is live...");
console.log(`📡 Monitoring factory: ${FACTORY}`);
console.log(`📊 Tracking ${cartridges.size} cartridges`);
console.log(`💬 Telegram commands ready!`);

const totalDestinations = dbSubscriptions.length + CHAT_DESTINATIONS.length;
console.log(`📢 Total notification destinations: ${totalDestinations}`);
if (dbSubscriptions.length > 0) {
  console.log(`   - ${dbSubscriptions.length} from database subscriptions`);
  dbSubscriptions.forEach((sub, i) => {
    console.log(`     ${i + 1}. ${sub.chat_title} (${sub.chat_id}${sub.topic_id ? ':' + sub.topic_id : ''})`);
  });
}
if (CHAT_DESTINATIONS.length > 0) {
  console.log(`   - ${CHAT_DESTINATIONS.length} from ENV configuration`);
  CHAT_DESTINATIONS.forEach((dest, i) => {
    console.log(`     ${i + 1}. ${dest.chatId}${dest.topicId ? ':' + dest.topicId : ''}`);
  });
}
if (totalDestinations === 0) {
  console.log(`   ⚠️ No destinations configured! Use /subscribe in a group or set TELEGRAM_CHAT_ID in .env`);
}

console.log(`⚡ Monitoring confirmed blocks for real-time updates!`);
console.log(`\n📋 First 5 tracked cartridges:`);
let count = 0;
for (const addr of cartridges) {
  if (count++ < 5) console.log(`   - ${addr}`);
}
console.log('');
