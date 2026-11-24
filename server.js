const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '.env') });

// Database and token signing are required for the API. Image storage is optional
// so a missing upload key cannot prevent the rest of the backend from starting.
const requiredEnvironment = ['MONGO_URI', 'JWT_SECRET'];
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
