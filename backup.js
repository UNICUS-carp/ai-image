// バックアップ・復旧システム
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

class BackupManager {
  constructor(database) {
    this.db = database;
    this.backupDir = process.env.BACKUP_DIR || './backups';
    this.maxBackups = parseInt(process.env.MAX_BACKUPS || '7'); // 7日分
  }

  // バックアップディレクトリの初期化
  async initializeBackupDir() {
    try {
      if (!fs.existsSync(this.backupDir)) {
        fs.mkdirSync(this.backupDir, { recursive: true });
        console.log('[backup] Backup directory created');
      }
    } catch (error) {
      console.error('[backup] Failed to create backup directory:', error.message);
      throw error;
    }
  }

  // データベースのバックアップ
  async createBackup() {
    try {
      await this.initializeBackupDir();
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFileName = `illustauto-backup-${timestamp}.db`;
      const backupPath = `${this.backupDir}/${backupFileName}`;
      
      const dbPath = process.env.DATABASE_PATH || './illustauto.db';
      
      // SQLiteデータベースをコピー
      if (fs.existsSync(dbPath)) {
        fs.copyFileSync(dbPath, backupPath);
        
        // 圧縮（オプション）
        if (process.env.COMPRESS_BACKUPS === 'true') {
          await execAsync(`gzip ${backupPath}`);
          console.log(`[backup] Compressed backup created: ${backupPath}.gz`);
        } else {
          console.log(`[backup] Backup created: ${backupPath}`);
        }
        
        // 古いバックアップを削除
        await this.cleanupOldBackups();
        
        return backupPath;
      } else {
        throw new Error('Database file not found');
      }
    } catch (error) {
      console.error('[backup] Backup creation failed:', error.message);
      throw error;
    }
  }

  // 古いバックアップの削除
  async cleanupOldBackups() {
    try {
      const files = fs.readdirSync(this.backupDir)
        .filter(file => file.startsWith('illustauto-backup-'))
        .map(file => ({
          name: file,
          time: fs.statSync(`${this.backupDir}/${file}`).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time);

      if (files.length > this.maxBackups) {
        const filesToDelete = files.slice(this.maxBackups);
        
        for (const file of filesToDelete) {
          fs.unlinkSync(`${this.backupDir}/${file.name}`);
          console.log(`[backup] Deleted old backup: ${file.name}`);
        }
      }
    } catch (error) {
      console.error('[backup] Cleanup failed:', error.message);
    }
  }

  // データベースの復元
  async restoreBackup(backupFileName) {
    try {
      const backupPath = `${this.backupDir}/${backupFileName}`;
      const dbPath = process.env.DATABASE_PATH || './illustauto.db';
      
      if (!fs.existsSync(backupPath)) {
        throw new Error(`Backup file not found: ${backupFileName}`);
      }
      
      // 現在のDBをバックアップ
      const currentBackup = `${dbPath}.pre-restore-${Date.now()}`;
      if (fs.existsSync(dbPath)) {
        fs.copyFileSync(dbPath, currentBackup);
        console.log(`[backup] Current database backed up to: ${currentBackup}`);
      }
      
      // 圧縮ファイルの場合は展開
      if (backupFileName.endsWith('.gz')) {
        await execAsync(`gunzip -c ${backupPath} > ${dbPath}`);
      } else {
        fs.copyFileSync(backupPath, dbPath);
      }
      
      console.log(`[backup] Database restored from: ${backupFileName}`);
      return true;
    } catch (error) {
      console.error('[backup] Restore failed:', error.message);
      throw error;
    }
  }

  // 利用可能なバックアップ一覧
  listBackups() {
    try {
      if (!fs.existsSync(this.backupDir)) {
        return [];
      }
      
      return fs.readdirSync(this.backupDir)
        .filter(file => file.startsWith('illustauto-backup-'))
        .map(file => {
          const stats = fs.statSync(`${this.backupDir}/${file}`);
          return {
            name: file,
            size: stats.size,
            created: stats.mtime,
            sizeHuman: this.formatBytes(stats.size)
          };
        })
        .sort((a, b) => b.created.getTime() - a.created.getTime());
    } catch (error) {
      console.error('[backup] List backups failed:', error.message);
      return [];
    }
  }

  // データベース整合性チェック
  async checkIntegrity() {
    try {
      const result = await this.db.get("PRAGMA integrity_check");
      const isValid = result && result.integrity_check === 'ok';
      
      console.log(`[backup] Database integrity: ${isValid ? 'OK' : 'CORRUPTED'}`);
      return isValid;
    } catch (error) {
      console.error('[backup] Integrity check failed:', error.message);
      return false;
    }
  }

  // 自動バックアップの開始
  startAutoBackup() {
    const interval = parseInt(process.env.BACKUP_INTERVAL_HOURS || '24') * 60 * 60 * 1000;
    
    setInterval(async () => {
      try {
        console.log('[backup] Starting automatic backup...');
        await this.createBackup();
        await this.checkIntegrity();
      } catch (error) {
        console.error('[backup] Automatic backup failed:', error.message);
      }
    }, interval);
    
    console.log(`[backup] Automatic backup scheduled every ${interval / 1000 / 60 / 60} hours`);
  }

  // ファイルサイズのフォーマット
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }
}

export default BackupManager;
