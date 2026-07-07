// Test fixture: a package config exercising `dev.proxy` resolution.
export default {
  dev: {
    proxy: {
      templates: {
        local: 'http://<release>.<packageName>.localhost',
        cloud: 'https://<env>.hulyo.co.il',
      },
      routes: {
        '/api': { packageName: 'backend-api', from: ['local', 'cloud'], default: 'cloud' },
        '/media': { packageName: 'backend-api', from: ['cloud'] },
      },
    },
  },
}
