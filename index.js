const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// In-memory job storage
const jobs = new Map();

// Keep-alive interval to prevent timeout
const KEEP_ALIVE_INTERVAL = 25000; // 25 seconds

// Ensure directories exist
const initDirectories = async () => {
  await fs.mkdir('temp', { recursive: true });
  await fs.mkdir('output', { recursive: true });
};

// Download image from URL with timeout
const downloadImage = async (url, filepath) => {
  console.log(`Downloading image from: ${url}`);
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
    timeout: 30000,
    maxRedirects: 5
  });
  
  const writer = require('fs').createWriteStream(filepath);
  response.data.pipe(writer);
  
  return new Promise((resolve, reject) => {
    writer.on('finish', () => {
      console.log(`Downloaded: ${filepath}`);
      resolve();
    });
    writer.on('error', reject);
  });
};

// Create video from images with timeout protection
const createVideo = async (jobId, image1Path, image2Path, duration, outputPath) => {
  return new Promise((resolve, reject) => {
    const halfDuration = duration / 2;
    
    // Instagram Reels size
    const width = 1080;
    const height = 1920;
    
    const textStartTime = duration - 3;
    
    console.log(`Starting FFmpeg for job ${jobId}`);
    console.log(`Duration: ${duration}s, Output: ${outputPath}`);
    
    // Keep-alive mechanism
    let lastProgress = 0;
    const keepAliveTimer = setInterval(() => {
      console.log(`Job ${jobId} keep-alive ping - last progress: ${lastProgress}%`);
    }, KEEP_ALIVE_INTERVAL);
    
    // Timeout mechanism (5 minutes max)
    const timeoutTimer = setTimeout(() => {
      clearInterval(keepAliveTimer);
      const error = new Error('FFmpeg processing timeout (5 minutes exceeded)');
      console.error(`Job ${jobId} timed out`);
      reject(error);
    }, 300000); // 5 minutes
    
    const command = ffmpeg();
    
    command
      // Input images with loop
      .input(image1Path)
      .inputOptions(['-loop', '1', '-t', String(halfDuration)])
      .input(image2Path)
      .inputOptions(['-loop', '1', '-t', String(halfDuration)])
      
      // Complex filter
      .complexFilter([
        // Scale and pad images
        `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30[img1]`,
        `[1:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30[img2]`,
        
        // Concatenate
        `[img1][img2]concat=n=2:v=1:a=0[v]`,
        
        // Add text
        `[v]drawtext=text='Free Download Link in Bio':fontsize=60:fontcolor=white:x=(w-text_w)/2:y=h-150:borderw=3:bordercolor=black:enable='gte(t,${textStartTime})'[vout]`
      ])
      .outputOptions([
        '-map', '[vout]',
        '-c:v', 'libx264',
        '-preset', 'ultrafast', // Changed from 'medium' for speed
        '-crf', '28', // Higher CRF = smaller file, faster encoding
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-threads', '2' // Limit threads for free tier
      ])
      .output(outputPath)
      .on('start', (cmd) => {
        console.log('FFmpeg started:', cmd);
        const job = jobs.get(jobId);
        if (job) {
          job.status = 'processing';
          job.started_at = new Date().toISOString();
        }
      })
      .on('progress', (progress) => {
        // Calculate proper progress based on timemark
        let calculatedProgress = 0;
        if (progress.timemark) {
          const parts = progress.timemark.split(':');
          const seconds = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
          calculatedProgress = Math.min(Math.round((seconds / duration) * 100), 99);
        } else if (progress.percent) {
          calculatedProgress = Math.min(Math.round(progress.percent), 99);
        }
        
        lastProgress = calculatedProgress;
        const job = jobs.get(jobId);
        if (job && calculatedProgress > 0) {
          job.progress = lastProgress;
          
          // Calculate remaining time based on progress
          if (job.started_at) {
            const elapsedMs = Date.now() - new Date(job.started_at).getTime();
            const elapsedSec = elapsedMs / 1000;
            const progressRatio = calculatedProgress / 100;
            
            if (progressRatio > 0.01) { // At least 1% progress
              const totalEstimatedSec = elapsedSec / progressRatio;
              const remainingSec = Math.max(0, Math.ceil(totalEstimatedSec - elapsedSec));
              job.remaining_time_seconds = remainingSec;
            }
          }
          
          console.log(`Job ${jobId}: ${lastProgress}% complete (remaining: ~${job.remaining_time_seconds}s)`);
        }
      })
      .on('end', () => {
        clearInterval(keepAliveTimer);
        clearTimeout(timeoutTimer);
        console.log(`Job ${jobId} completed successfully`);
        const job = jobs.get(jobId);
        if (job) {
          job.status = 'completed';
          job.progress = 100;
        }
        resolve();
      })
      .on('error', (err, stdout, stderr) => {
        clearInterval(keepAliveTimer);
        clearTimeout(timeoutTimer);
        console.error(`Job ${jobId} FFmpeg error:`, err.message);
        console.error('FFmpeg stderr:', stderr);
        const job = jobs.get(jobId);
        if (job) {
          job.status = 'failed';
          job.error = err.message;
        }
        reject(err);
      });
    
    try {
      command.run();
    } catch (err) {
      clearInterval(keepAliveTimer);
      clearTimeout(timeoutTimer);
      reject(err);
    }
  });
};

// Cleanup temp files
const cleanup = async (files) => {
  for (const file of files) {
    try {
      await fs.unlink(file);
      console.log(`Cleaned up: ${file}`);
    } catch (err) {
      console.error(`Failed to delete ${file}:`, err.message);
    }
  }
};

// POST /convert - Create new video conversion job
app.post('/convert', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { image1_url, image2_url, duration = 30 } = req.body;
    
    console.log('=== New conversion request ===');
    console.log('Image 1:', image1_url);
    console.log('Image 2:', image2_url);
    console.log('Duration:', duration);
    
    if (!image1_url || !image2_url) {
      return res.status(400).json({ 
        error: 'Both image1_url and image2_url are required' 
      });
    }
    
    if (duration < 1 || duration > 300) {
      return res.status(400).json({ 
        error: 'Duration must be between 1 and 300 seconds (5 minutes max)' 
      });
    }
    
    const jobId = uuidv4();
    const image1Path = path.join('temp', `${jobId}_img1.jpg`);
    const image2Path = path.join('temp', `${jobId}_img2.jpg`);
    const outputPath = path.join('output', `${jobId}.mp4`);
    
    // Estimate: ~2-3x video duration for processing
    // Add 30s for download time
    const estimatedTime = Math.ceil(duration * 2.5) + 30;
    
    // Create job entry
    jobs.set(jobId, {
      id: jobId,
      status: 'queued',
      progress: 0,
      created_at: new Date().toISOString(),
      started_at: null,
      estimated_time_seconds: estimatedTime,
      remaining_time_seconds: estimatedTime,
      duration: duration
    });
    
    console.log(`Created job ${jobId}`);
    
    // Return immediately
    res.json({
      job_id: jobId,
      status: 'queued',
      estimated_time_seconds: estimatedTime,
      status_url: `/status/${jobId}`,
      message: 'Job created successfully. Use status_url to check progress.'
    });
    
    // Process asynchronously
    (async () => {
      try {
        console.log(`[${jobId}] Starting download phase...`);
        
        // Download images
        await downloadImage(image1_url, image1Path);
        await downloadImage(image2_url, image2Path);
        
        console.log(`[${jobId}] Images downloaded, starting video creation...`);
        
        // Create video
        await createVideo(jobId, image1Path, image2Path, duration, outputPath);
        
        console.log(`[${jobId}] Video created successfully`);
        
        // Verify output exists
        const stats = await fs.stat(outputPath);
        console.log(`[${jobId}] Output file size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
        
        // Update job with download link
        const job = jobs.get(jobId);
        if (job) {
          job.download_url = `/download/${jobId}`;
          job.file_size_mb = (stats.size / 1024 / 1024).toFixed(2);
        }
        
        // Cleanup temp files
        await cleanup([image1Path, image2Path]);
        
        const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[${jobId}] Completed in ${totalTime}s`);
        
      } catch (error) {
        console.error(`[${jobId}] Failed:`, error);
        const job = jobs.get(jobId);
        if (job) {
          job.status = 'failed';
          job.error = error.message;
        }
        
        // Cleanup on error
        await cleanup([image1Path, image2Path, outputPath]);
      }
    })();
    
  } catch (error) {
    console.error('Error creating job:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /status/:jobId
app.get('/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  res.json({
    job_id: job.id,
    status: job.status,
    progress: job.progress,
    created_at: job.created_at,
    estimated_time_seconds: job.estimated_time_seconds,
    remaining_time_seconds: job.remaining_time_seconds || job.estimated_time_seconds,
    duration: job.duration,
    download_url: job.download_url || null,
    file_size_mb: job.file_size_mb || null,
    error: job.error || null
  });
});

// GET /download/:jobId
app.get('/download/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  if (job.status !== 'completed') {
    return res.status(400).json({ 
      error: 'Video not ready yet',
      status: job.status,
      progress: job.progress
    });
  }
  
  const videoPath = path.join('output', `${jobId}.mp4`);
  
  try {
    await fs.access(videoPath);
    res.download(videoPath, `video_${jobId}.mp4`);
  } catch (error) {
    console.error('Download error:', error);
    res.status(404).json({ error: 'Video file not found' });
  }
});

// GET /health
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    active_jobs: jobs.size,
    jobs_by_status: {
      queued: Array.from(jobs.values()).filter(j => j.status === 'queued').length,
      processing: Array.from(jobs.values()).filter(j => j.status === 'processing').length,
      completed: Array.from(jobs.values()).filter(j => j.status === 'completed').length,
      failed: Array.from(jobs.values()).filter(j => j.status === 'failed').length
    },
    timestamp: new Date().toISOString(),
    uptime_seconds: process.uptime()
  });
});

// GET /jobs - List all jobs (for debugging)
app.get('/jobs', (req, res) => {
  const jobList = Array.from(jobs.values()).map(job => ({
    job_id: job.id,
    status: job.status,
    progress: job.progress,
    created_at: job.created_at,
    error: job.error || null
  }));
  
  res.json({
    total: jobList.length,
    jobs: jobList
  });
});

// Cleanup old jobs (every hour)
setInterval(() => {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  
  for (const [jobId, job] of jobs.entries()) {
    const age = now - new Date(job.created_at).getTime();
    if (age > maxAge) {
      const videoPath = path.join('output', `${jobId}.mp4`);
      cleanup([videoPath]);
      jobs.delete(jobId);
      console.log(`Cleaned up old job: ${jobId}`);
    }
  }
}, 60 * 60 * 1000);

// Initialize and start
const PORT = process.env.PORT || 3000;

initDirectories().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`========================================`);
    console.log(`Image to Video API running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Endpoints:`);
    console.log(`  POST   /convert      - Create conversion job`);
    console.log(`  GET    /status/:id   - Check job status`);
    console.log(`  GET    /download/:id - Download video`);
    console.log(`  GET    /health       - Health check`);
    console.log(`  GET    /jobs         - List all jobs`);
    console.log(`========================================`);
  });
}).catch(err => {
  console.error('Failed to initialize:', err);
  process.exit(1);
});
