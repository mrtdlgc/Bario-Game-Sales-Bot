CREATE TABLE IF NOT EXISTS cartridges (
  address TEXT PRIMARY KEY,
  title TEXT,
  game_link TEXT,
  genre TEXT,
  image TEXT,
  ipfs TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);