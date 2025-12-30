const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// In-memory job storage (use Redis/DB for production)
const jobs = new Map();

// Ensure directories exist
const initDirectories = async () => {
  await fs.mkdir('temp', { recursive: true });
  await fs.mkdir('output', { recursive: true });
};

// Download image from URL
const downloadImage = async (url, filepath) => {
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream'
  });
  
  const writer = require('fs').createWriteStream(filepath);
  response.data.pipe(writer);
  
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
};

// Create video from images
const createVideo = async (jobId, image1Path, image2Path, duration, outputPath) => {
  return new Promise((resolve, reject) => {
    const halfDuration = duration / 2;
    
    // Instagram Reels size: 1080x1920 (9:16)
    const width = 1080;
    const height = 1920;
    
    // Calculate text display time (last 3 seconds)
    const textStartTime = duration - 3;
    
    ffmpeg()
      // Input images
      .input(image1Path)
      .loop(halfDuration)
      .input(image2Path)
      .loop(halfDuration)
      
      // Complex filter for transitions and text
      .complexFilter([
        // Scale and pad images to 9:16 with black background
        `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30[img1]`,
        `[1:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30[img2]`,
        
        // Concatenate images
        `[img1][img2]concat=n=2:v=1:a=0[v]`,
        
        // Add text overlay (last 3 seconds)
        `[v]drawtext=text='Free Download Link in Bio':fontsize=60:fontcolor=white:x=(w-text_w)/2:y=h-150:borderw=3:bordercolor=black:enable='gte(t,${textStartTime})'[vout]`
      ])
      .outputOptions([
        '-map', '[vout]',
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart'
      ])
      .output(outputPath)
      .on('start', (cmd) => {
        console.log('FFmpeg command:', cmd);
        jobs.get(jobId).status = 'processing';
      })
      .on('progress', (progress) => {
        const percent = Math.round(progress.percent || 0);
        jobs.get(jobId).progress = percent;
        console.log(`Job ${jobId}: ${percent}% complete`);
      })
      .on('end', () => {
        jobs.get(jobId).status = 'completed';
        jobs.get(jobId).progress = 100;
        resolve();
      })
      .on('error', (err) => {
        jobs.get(jobId).status = 'failed';
        jobs.get(jobId).error = err.message;
        reject(err);
      })
      .run();
  });
};

// Cleanup temp files
const cleanup = async (files) => {
  for (const file of files) {
    try {
      await fs.unlink(file);
    } catch (err) {
      console.error(`Failed to delete ${file}:`, err);
    }
  }
};

// POST /convert - Create new video conversion job
app.post('/convert', async (req, res) => {
  try {
    const { image1_url, image2_url, duration = 30 } = req.body;
    
    if (!image1_url || !image2_url) {
      return res.status(400).json({ 
        error: 'Both image1_url and image2_url are required' 
      });
    }
    
    if (![5, 30].includes(duration)) {
      return res.status(400).json({ 
        error: 'Duration must be either 5 or 30 seconds' 
      });
    }
    
    const jobId = uuidv4();
    const image1Path = path.join('temp', `${jobId}_img1.jpg`);
    const image2Path = path.join('temp', `${jobId}_img2.jpg`);
    const outputPath = path.join('output', `${jobId}.mp4`);
    
    // Estimate processing time (rough estimate: 2-3x video duration)
    const estimatedTime = duration * 2.5;
    
    // Create job entry
    jobs.set(jobId, {
      id: jobId,
      status: 'queued',
      progress: 0,
      created_at: new Date().toISOString(),
      estimated_time_seconds: estimatedTime,
      duration: duration
    });
    
    // Return job info immediately
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
        // Download images
        await downloadImage(image1_url, image1Path);
        await downloadImage(image2_url, image2Path);
        
        // Create video
        await createVideo(jobId, image1Path, image2Path, duration, outputPath);
        
        // Update job with download link
        jobs.get(jobId).download_url = `/download/${jobId}`;
        
        // Cleanup temp files
        await cleanup([image1Path, image2Path]);
        
      } catch (error) {
        console.error(`Job ${jobId} failed:`, error);
        jobs.get(jobId).status = 'failed';
        jobs.get(jobId).error = error.message;
        
        // Cleanup on error
        await cleanup([image1Path, image2Path, outputPath]);
      }
    })();
    
  } catch (error) {
    console.error('Error creating job:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /status/:jobId - Check job status
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
    duration: job.duration,
    download_url: job.download_url || null,
    error: job.error || null
  });
});

// GET /download/:jobId - Download completed video
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
    res.download(videoPath, 'video.mp4', async (err) => {
      if (err) {
        console.error('Download error:', err);
      }
      
      // Optional: Delete after download (uncomment if needed)
      // await cleanup([videoPath]);
      // jobs.delete(jobId);
    });
  } catch (error) {
    res.status(404).json({ error: 'Video file not found' });
  }
});

// GET /health - Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    active_jobs: jobs.size,
    timestamp: new Date().toISOString()
  });
});

// Cleanup old jobs (run every hour)
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

// Initialize and start server
const PORT = process.env.PORT || 3000;

initDirectories().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Image to Video API running on port ${PORT}`);
    console.log(`Endpoints:`);
    console.log(`  POST   /convert      - Create new conversion job`);
    console.log(`  GET    /status/:id   - Check job status`);
    console.log(`  GET    /download/:id - Download completed video`);
    console.log(`  GET    /health       - Health check`);
  });
});
