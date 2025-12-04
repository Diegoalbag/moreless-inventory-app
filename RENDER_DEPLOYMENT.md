# Deploying to Render

## Prerequisites
1. A Render account (sign up at https://render.com)
2. Your Shopify app credentials

## Deployment Steps

### 1. Push your code to GitHub
```bash
git add .
git commit -m "Prepare for Render deployment"
git push origin main
```

### 2. Create a new Web Service on Render

1. Go to https://dashboard.render.com
2. Click "New +" → "Web Service"
3. Connect your GitHub repository
4. Select the `moreless-inventory` repository
5. Render will auto-detect the `render.yaml` file

### 3. Create PostgreSQL Database

1. In Render dashboard, click "New +" → "PostgreSQL"
2. Name it: `moreless-inventory-db`
3. Select "Free" plan
4. Note the connection string (you'll need this)

### 4. Set Environment Variables

In your Render Web Service settings, add these environment variables:

```
SHOPIFY_API_KEY=your_api_key_from_partner_dashboard
SHOPIFY_API_SECRET=your_api_secret_from_partner_dashboard
SHOPIFY_APP_URL=https://your-app-name.onrender.com
SCOPES=write_products,read_orders,write_inventory
NODE_ENV=production
```

**Important:** 
- Replace `your-app-name` with your actual Render service name
- Get your API key and secret from https://partners.shopify.com

### 5. Link Database

1. In your Web Service settings
2. Go to "Environment" tab
3. The `DATABASE_URL` should be automatically linked from the PostgreSQL service
4. If not, manually add it with the connection string from your database

### 6. Deploy

1. Render will automatically deploy when you push to GitHub
2. Or click "Manual Deploy" → "Deploy latest commit"
3. Wait for the build to complete (5-10 minutes)

### 7. Update Shopify App URL

After deployment, you'll get a URL like: `https://your-app-name.onrender.com`

1. Update `shopify.app.toml`:
   ```toml
   application_url = "https://your-app-name.onrender.com"
   ```

2. Update redirect URLs:
   ```toml
   [auth]
   redirect_urls = [ "https://your-app-name.onrender.com/api/auth" ]
   ```

3. Deploy the config to Shopify:
   ```bash
   shopify app deploy
   ```

### 8. Test the Deployment

1. Visit your Render URL
2. Install the app on a test store
3. Test the webhook functionality

## Troubleshooting

### Database Connection Issues
- Make sure the PostgreSQL database is created and linked
- Check that `DATABASE_URL` is set correctly
- Verify the database is on the same plan/region

### Build Failures
- Check the build logs in Render dashboard
- Ensure all environment variables are set
- Verify Node.js version matches (20.x)

### App Not Loading
- Verify `SHOPIFY_APP_URL` matches your Render URL
- Check that `shopify app deploy` was run after updating URLs
- Ensure HTTPS is enabled (Render provides this automatically)

## Notes

- Render free tier spins down after 15 minutes of inactivity
- First request after spin-down may take 30-60 seconds
- Consider upgrading to paid plan for production use
- Database backups are recommended for production

