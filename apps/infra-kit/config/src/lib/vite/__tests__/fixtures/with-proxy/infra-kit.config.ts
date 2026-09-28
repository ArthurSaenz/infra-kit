// Test fixture: a package config exercising `dev.proxy` resolution.
export default {
  deployedUrlEnv: 'CLIENT_URL',
  dev: {
    proxy: {
      templates: {
        local: 'http://<release>.<packageName>.localhost',
      },
      routes: {
        '/api': { packageName: 'backend-api', from: ['local', 'cloud'], default: 'cloud' },
        '/media': { packageName: 'backend-api', from: ['cloud'] },
      },
    },
  },
}
