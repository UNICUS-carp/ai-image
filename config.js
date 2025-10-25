// 設定管理・バリデーションシステム
class ConfigManager {
  constructor() {
    this.requiredEnvVars = [
      'NODE_ENV',
      'GEMINI_API_KEY',
      'ADMIN_EMAILS'
    ];
    
    this.optionalEnvVars = {
      'OPENAI_API_KEY': 'OpenAI API access will be unavailable',
      'DATABASE_PATH': 'Will use default path ./illustauto.db',
      'ALLOWED_ORIGINS': 'Will use default https://unicus.top',
      'BACKUP_DIR': 'Will use default ./backups',
      'MAX_BACKUPS': 'Will keep 7 backups by default',
      'BACKUP_INTERVAL_HOURS': 'Will backup every 24 hours by default'
    };
  }

  // 必須環境変数の検証
  validateRequired() {
    const missing = [];
    const warnings = [];

    for (const envVar of this.requiredEnvVars) {
      if (!process.env[envVar]) {
        missing.push(envVar);
      }
    }

    // NODE_ENV特有の検証
    if (process.env.NODE_ENV && !['development', 'production', 'test'].includes(process.env.NODE_ENV)) {
      warnings.push(`NODE_ENV should be 'development', 'production', or 'test', got '${process.env.NODE_ENV}'`);
    }

    // API key形式の基本検証
    if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.length < 10) {
      warnings.push('GEMINI_API_KEY appears to be too short');
    }

    if (process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY.startsWith('sk-')) {
      warnings.push('OPENAI_API_KEY should start with "sk-"');
    }

    // メールアドレス形式の検証
    if (process.env.ADMIN_EMAILS) {
      const emails = process.env.ADMIN_EMAILS.split(',').map(e => e.trim());
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      
      for (const email of emails) {
        if (!emailRegex.test(email)) {
          warnings.push(`Invalid admin email format: ${email}`);
        }
      }
    }

    return { missing, warnings };
  }

  // オプション環境変数の確認
  checkOptional() {
    const info = [];

    for (const [envVar, message] of Object.entries(this.optionalEnvVars)) {
      if (!process.env[envVar]) {
        info.push(`${envVar} not set: ${message}`);
      }
    }

    return info;
  }

  // 本番環境特有の検証
  validateProduction() {
    const issues = [];

    if (process.env.NODE_ENV === 'production') {
      // 本番環境で必須の設定
      if (!process.env.ALLOWED_ORIGINS) {
        issues.push('ALLOWED_ORIGINS should be set in production');
      }

      if (!process.env.DATABASE_PATH) {
        issues.push('DATABASE_PATH should be explicitly set in production');
      }

      // セキュリティ関連の警告
      if (process.env.DATABASE_PATH === ':memory:') {
        issues.push('CRITICAL: In-memory database detected in production - data will be lost on restart');
      }

      // バックアップ設定の確認
      if (!process.env.BACKUP_DIR) {
        issues.push('BACKUP_DIR should be set in production for data safety');
      }
    }

    return issues;
  }

  // 設定値の取得（デフォルト値付き）
  get(key, defaultValue = null) {
    return process.env[key] || defaultValue;
  }

  // 数値設定の取得
  getNumber(key, defaultValue = 0) {
    const value = process.env[key];
    if (!value) return defaultValue;
    
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? defaultValue : parsed;
  }

  // ブール設定の取得
  getBoolean(key, defaultValue = false) {
    const value = process.env[key];
    if (!value) return defaultValue;
    
    return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
  }

  // 配列設定の取得（カンマ区切り）
  getArray(key, defaultValue = []) {
    const value = process.env[key];
    if (!value) return defaultValue;
    
    return value.split(',').map(item => item.trim()).filter(Boolean);
  }

  // 全設定の検証実行
  validateAll() {
    const results = {
      valid: true,
      missing: [],
      warnings: [],
      info: [],
      production: []
    };

    // 必須項目の検証
    const required = this.validateRequired();
    results.missing = required.missing;
    results.warnings = required.warnings;

    // オプション項目の確認
    results.info = this.checkOptional();

    // 本番環境の検証
    results.production = this.validateProduction();

    // 全体的な有効性判定
    results.valid = results.missing.length === 0 && 
                   results.production.filter(issue => issue.includes('CRITICAL')).length === 0;

    return results;
  }

  // 検証結果の表示
  displayValidation() {
    const validation = this.validateAll();

    console.log('\n========================================');
    console.log('🔧 Configuration Validation Results');
    console.log('========================================');

    if (validation.missing.length > 0) {
      console.log('\n❌ Missing Required Variables:');
      validation.missing.forEach(env => console.log(`   - ${env}`));
    }

    if (validation.warnings.length > 0) {
      console.log('\n⚠️  Warnings:');
      validation.warnings.forEach(warning => console.log(`   - ${warning}`));
    }

    if (validation.production.length > 0) {
      console.log('\n🔒 Production Issues:');
      validation.production.forEach(issue => console.log(`   - ${issue}`));
    }

    if (validation.info.length > 0 && process.env.NODE_ENV !== 'production') {
      console.log('\n💡 Optional Configuration:');
      validation.info.forEach(info => console.log(`   - ${info}`));
    }

    if (validation.valid) {
      console.log('\n✅ Configuration is valid for startup');
    } else {
      console.log('\n❌ Configuration issues detected - review before production use');
    }

    console.log('========================================\n');

    return validation;
  }

  // 設定サマリーの取得（機密情報を除く）
  getSummary() {
    return {
      environment: process.env.NODE_ENV || 'development',
      hasGeminiAPI: !!this.get('GEMINI_API_KEY'),
      hasOpenAIAPI: !!this.get('OPENAI_API_KEY'),
      databasePath: this.get('DATABASE_PATH', './illustauto.db'),
      allowedOrigins: this.getArray('ALLOWED_ORIGINS', ['https://unicus.top']),
      adminCount: this.getArray('ADMIN_EMAILS').length,
      backupEnabled: !!this.get('BACKUP_DIR'),
      backupInterval: this.getNumber('BACKUP_INTERVAL_HOURS', 24)
    };
  }
}

export default ConfigManager;
