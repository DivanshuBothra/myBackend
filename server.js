const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '.env') });

// Fail early when the database, token signing key, or external image storage key is absent.
const requiredEnvironment = ['MONGO_URI', 'JWT_SECRET', 'IMAGEKIT_PRIVATE_KEY'];
const missingEnvironment = requiredEnvironment.filter((name) => !process.env[name]?.trim());

if (missingEnvironment.length > 0) {
  console.error(`Missing required environment variables: ${missingEnvironment.join(', ')}`);
  process.exit(1);
}

const app = require('./src/app');
const { connectDB } = require('./src/db/db');

async function startServer() {
  await connectDB();

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

startServer().catch(() => {
  process.exit(1);
});
