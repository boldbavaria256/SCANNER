package com.ltech.documentscanner;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

public class MainActivity extends Activity {
    private static final int CAMERA_PERMISSION_REQUEST = 1001;
    private static final int CREATE_PDF_REQUEST = 1002;
    private static final int FILE_CHOOSER_REQUEST = 1003;

    private WebView webView;
    private PermissionRequest pendingWebPermission;
    private byte[] pendingPdfBytes;
    private String pendingPdfFilename;
    private ValueCallback<Uri[]> filePathCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WebView.setWebContentsDebuggingEnabled(false);
        webView = new WebView(this);
        setContentView(webView);

        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.addJavascriptInterface(new AndroidBridge(), "AndroidBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                return !"appassets.androidplatform.net".equals(uri.getHost());
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> handleWebPermissionRequest(request));
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (pendingWebPermission == request) pendingWebPermission = null;
            }

            @Override
            public boolean onShowFileChooser(WebView webView,
                                             ValueCallback<Uri[]> filePathCallbackParam,
                                             FileChooserParams fileChooserParams) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = filePathCallbackParam;
                try {
                    Intent intent = fileChooserParams.createIntent();
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                    return true;
                } catch (Exception e) {
                    filePathCallback = null;
                    Toast.makeText(MainActivity.this, "Could not open gallery.", Toast.LENGTH_SHORT).show();
                    return false;
                }
            }
        });

        webView.loadUrl("https://appassets.androidplatform.net/assets/index.html");
    }

    private void handleWebPermissionRequest(PermissionRequest request) {
        boolean wantsCamera = false;
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                wantsCamera = true;
                break;
            }
        }
        if (!wantsCamera) {
            request.deny();
            return;
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            return;
        }
        pendingWebPermission = request;
        requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION_REQUEST);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != CAMERA_PERMISSION_REQUEST || pendingWebPermission == null) return;
        PermissionRequest request = pendingWebPermission;
        pendingWebPermission = null;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        } else {
            request.deny();
            Toast.makeText(this, "Camera permission is required to scan documents.", Toast.LENGTH_LONG).show();
        }
    }

    private void promptForPdfLocation(String filename, byte[] bytes) {
        pendingPdfFilename = sanitizeFilename(filename);
        pendingPdfBytes = bytes;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/pdf");
        intent.putExtra(Intent.EXTRA_TITLE, pendingPdfFilename);
        startActivityForResult(intent, CREATE_PDF_REQUEST);
    }

    private File scansDir() {
        File dir = new File(getFilesDir(), "scans");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    private File savedScanFile(String filename) {
        return new File(scansDir(), sanitizeFilename(filename));
    }

    private void archivePdf(String filename, byte[] bytes) throws Exception {
        File file = savedScanFile(filename);
        try (FileOutputStream output = new FileOutputStream(file, false)) {
            output.write(bytes);
            output.flush();
        }
    }

    private void shareFile(File pdf, String chooserTitle) {
        if (pdf == null || !pdf.exists()) {
            Toast.makeText(this, "Saved PDF is no longer available.", Toast.LENGTH_LONG).show();
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", pdf);
            Intent intent = new Intent(Intent.ACTION_SEND);
            intent.setType("application/pdf");
            intent.putExtra(Intent.EXTRA_STREAM, uri);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(Intent.createChooser(intent, chooserTitle));
        } catch (Exception e) {
            Toast.makeText(this, "Could not share PDF: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void sharePdf(String filename, byte[] bytes) {
        try {
            String cleanName = sanitizeFilename(filename);
            File shareDir = new File(getCacheDir(), "shared_pdfs");
            if (!shareDir.exists() && !shareDir.mkdirs()) throw new IllegalStateException("Could not prepare sharing folder.");
            File pdf = new File(shareDir, cleanName);
            try (FileOutputStream output = new FileOutputStream(pdf, false)) {
                output.write(bytes);
                output.flush();
            }
            shareFile(pdf, "Share PDF");
        } catch (Exception e) {
            Toast.makeText(this, "Could not share PDF: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void openSavedPdf(String filename) {
        File pdf = savedScanFile(filename);
        if (!pdf.exists()) {
            Toast.makeText(this, "This saved scan is no longer available in the app.", Toast.LENGTH_LONG).show();
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", pdf);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/pdf");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "Install a PDF viewer to open saved scans.", Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            Toast.makeText(this, "Could not open PDF: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void clearSavedScans() {
        File dir = scansDir();
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File file : files) {
            if (file.isFile()) file.delete();
        }
    }

    private void evaluateJs(String javascript) {
        if (webView == null) return;
        runOnUiThread(() -> {
            if (webView != null) webView.evaluateJavascript(javascript, null);
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode == FILE_CHOOSER_REQUEST) {
            if (filePathCallback != null) {
                Uri[] results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
                filePathCallback.onReceiveValue(results);
                filePathCallback = null;
            }
            return;
        }

        if (requestCode != CREATE_PDF_REQUEST) return;
        if (resultCode == RESULT_OK && data != null && data.getData() != null && pendingPdfBytes != null) {
            Uri uri = data.getData();
            try (OutputStream output = getContentResolver().openOutputStream(uri, "w")) {
                if (output == null) throw new IllegalStateException("Could not open the selected file.");
                output.write(pendingPdfBytes);
                output.flush();
                archivePdf(pendingPdfFilename, pendingPdfBytes);
                Toast.makeText(this, "PDF saved.", Toast.LENGTH_SHORT).show();
                evaluateJs("window.onNativePdfSaved && window.onNativePdfSaved(" + JSONObject.quote(pendingPdfFilename) + "," + pendingPdfBytes.length + ");");
            } catch (Exception e) {
                Toast.makeText(this, "Could not save PDF: " + e.getMessage(), Toast.LENGTH_LONG).show();
            }
        } else {
            evaluateJs("window.onNativePdfSaveCancelled && window.onNativePdfSaveCancelled();");
        }
        pendingPdfBytes = null;
        pendingPdfFilename = null;
    }

    private String sanitizeFilename(String filename) {
        String clean = filename == null ? "Scanned Document.pdf" : filename.replaceAll("[^A-Za-z0-9 ._()-]", "-").trim();
        if (clean.isEmpty()) clean = "Scanned Document.pdf";
        if (!clean.toLowerCase().endsWith(".pdf")) clean += ".pdf";
        return clean;
    }

    public class AndroidBridge {
        @JavascriptInterface
        public void savePdf(String filename, String base64Data) {
            try {
                byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);
                runOnUiThread(() -> promptForPdfLocation(filename, bytes));
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this,
                        "Could not prepare PDF: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }

        @JavascriptInterface
        public void sharePdf(String filename, String base64Data) {
            try {
                byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);
                runOnUiThread(() -> MainActivity.this.sharePdf(filename, bytes));
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this,
                        "Could not prepare PDF: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }

        @JavascriptInterface
        public void openSavedPdf(String filename) {
            runOnUiThread(() -> MainActivity.this.openSavedPdf(filename));
        }

        @JavascriptInterface
        public void shareSavedPdf(String filename) {
            runOnUiThread(() -> shareFile(savedScanFile(filename), "Share saved scan"));
        }

        @JavascriptInterface
        public void clearSavedScans() {
            runOnUiThread(MainActivity.this::clearSavedScans);
        }
    }

    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript("window.handleNativeBack ? String(window.handleNativeBack()) : 'false'", value -> {
            boolean handled = value != null && value.contains("true");
            if (!handled) MainActivity.super.onBackPressed();
        });
    }

    @Override
    protected void onPause() {
        evaluateJs("window.onNativePause && window.onNativePause();");
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        evaluateJs("window.onNativeResume && window.onNativeResume();");
    }

    @Override
    protected void onDestroy() {
        if (filePathCallback != null) {
            filePathCallback.onReceiveValue(null);
            filePathCallback = null;
        }
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.stopLoading();
            webView.removeJavascriptInterface("AndroidBridge");
            webView.removeAllViews();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
