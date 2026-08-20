const app = require('./src/app');
const { PORT } = require('./src/config/env');

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
