# Subscription System - Quick Guide

## 🎯 Overview

Your bot now has a **subscription system** so anyone with admin rights can manage notifications without touching the ENV file or code. Perfect for continuity!

## 🚀 Quick Start

### For Admins (Non-technical)

1. **Add the bot to your group/channel**
2. **Make it an admin** (with "Post Messages" permission)
3. **In the group, send:** `/subscribe`
4. **Done!** You'll now get notifications

### To Stop Notifications

Send `/unsubscribe` in the group/topic

### To See All Subscriptions

Send `/subscribers` anywhere (admins only)

## 📋 How It Works

### Subscription Commands

| Command | Who Can Use | Where | What It Does |
|---------|-------------|-------|--------------|
| `/subscribe` | Admins only | Groups/Channels | Start receiving notifications |
| `/unsubscribe` | Admins only | Groups/Channels | Stop receiving notifications |
| `/subscribers` | Admins | Anywhere | View all active subscriptions |

### What You'll Receive

Once subscribed, you get:
- 🎮 New cartridge deployments
- 🚀 Sale notifications  
- 🔄 Link update alerts (when new games are added)

## 🧵 Topics/Forums

If your group uses **topics** (forum mode):

1. Open the specific topic you want notifications in
2. Send `/subscribe` **in that topic**
3. Only that topic will get notifications

You can subscribe multiple topics in the same group!

## 🔐 Security

- **Only group admins** can subscribe/unsubscribe
- Bot checks admin status before each subscription change
- All subscriptions are stored in the database
- No one needs access to the server or ENV files

## 💾 Database Storage

Subscriptions are stored in PostgreSQL alongside your cartridges:

```sql
subscriptions table:
- chat_id (the group/channel ID)
- topic_id (optional, for forum topics)
- chat_title (group name)
- chat_type (group/channel/supergroup)
- subscribed_by_id (who subscribed)
- subscribed_by_name (their username)
- subscribed_at (timestamp)
```

## 🔄 Backward Compatibility

**ENV still works!** If you have `TELEGRAM_CHAT_ID` in your `.env`, the bot will send to BOTH:
- ENV-configured destinations (your old setup)
- Database subscriptions (new system)

You can gradually migrate to the subscription system and remove the ENV variable when ready.

## 📊 Example Scenarios

### Scenario 1: Single Group
```
Admin adds bot to "Bario Sales" group
Admin sends: /subscribe
✅ Group is now subscribed
```

### Scenario 2: Multiple Topics
```
Admin adds bot to group with topics
In "Sales" topic: /subscribe
In "Announcements" topic: /subscribe
✅ Both topics now get notifications
```

### Scenario 3: Channel + Group
```
Bot already posts to channel (via ENV)
Admin adds bot to group: /subscribe
✅ Now posts to both channel and group
```

### Scenario 4: Team Handoff
```
You: Add bot, subscribe group
Teammate: Takes over, sees /subscribers
Teammate: Can /subscribe other groups
✅ No ENV access needed!
```

## 🛠️ Admin Guide

### Check Current Subscriptions
```
/subscribers
```

Returns:
```
📢 Active Subscriptions (2)

1. Bario Sales Group
   Type: supergroup
   ID: -1001234567890

2. Bario Announcements
   Type: supergroup  
   ID: -1002222222222
   Topic: 41
```

### Troubleshooting

**Bot doesn't respond to /subscribe**
- ✅ Make sure bot is admin
- ✅ Check you're in a group (not private chat)
- ✅ Verify you're an admin

**"Only administrators can subscribe"**
- ✅ You need admin rights in the group
- ✅ Bot checks this automatically

**Notifications not arriving**
- ✅ Send `/subscribers` to verify subscription is active
- ✅ Check bot has permission to post
- ✅ In topics, make sure bot can post to that specific topic

## 🎓 For Developers

The subscription system:
- Uses existing PostgreSQL database
- Adds a `subscriptions` table automatically
- Checks admin status via Telegram API
- Handles topics via `message_thread_id`
- Merges database + ENV destinations when sending

### Key Functions
```javascript
await addSubscription(chatId, topicId, ...)
await removeSubscription(chatId, topicId)
await getSubscriptions()
await isSubscribed(chatId, topicId)
await isUserAdmin(chatId, userId)
```

## 🚨 Important Notes

1. **Admin permissions are required** - This prevents random users from subscribing your bot everywhere
2. **Database-first** - Subscriptions survive bot restarts
3. **No ENV needed** - Perfect for team management
4. **Backward compatible** - Your existing ENV setup still works

## 🎉 Benefits

✅ **No code changes needed** to add new groups  
✅ **Team members can manage** without server access  
✅ **Survives server migrations** (just database backup)  
✅ **Audit trail** - see who subscribed and when  
✅ **Flexible** - subscribe/unsubscribe anytime

---

**Perfect for continuity!** If something happens to you, your team can still manage the bot through Telegram commands. 🙌