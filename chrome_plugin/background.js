chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getImages') {
        chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
            chrome.scripting.executeScript({
                target: {tabId: tabs[0].id},
                files: ['rip_images.js']
            });
        });
    }
    if (request.imageUrls) {
        chrome.storage.local.set({imageUrls: request.imageUrls}, () => {
            console.log('Image URLs stored.');
        });
    }
});

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: "detect-ai-text",
        title: "Detect AI in selected text",
        contexts: ["selection"]
    });
    chrome.contextMenus.create({
        id: "detect-ai-image",
        title: "Detect AI in this image",
        contexts: ["image"]
    });
    chrome.contextMenus.create({
        id: "detect-ai-video",
        title: "Detect AI in this video",
        contexts: ["video"]
    });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    let requestBody;
    let type;

    if (info.menuItemId === "detect-ai-text" && info.selectionText) {
        type = "text";
        requestBody = { type: type, content: info.selectionText };
    } else if (info.menuItemId === "detect-ai-image" && info.srcUrl) {
        type = "image";
        requestBody = { type: type, content: info.srcUrl };
    } else if (info.menuItemId === "detect-ai-video" && info.srcUrl) {
        type = "video";
        requestBody = { type: type, content: info.srcUrl };
    } else {
        return;
    }

    chrome.windows.create({
        url: "popup.html",
        type: "popup",
        width: 600,
        height: 400
    });

    fetch("http://localhost:5000/detect", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody)
    })
    .then(response => response.json())
    .then(data => {
        setTimeout(() => {
            chrome.runtime.sendMessage({
                action: "setConfidence",
                confidence: data.confidence,
                contentType: type
            });
        }, 100);
    })
    .catch(error => {
        console.error("Error during AI detection:", error);
        chrome.runtime.sendMessage({
            action: "setConfidence",
            confidence: "Error",
            contentType: type
        });
    });
});
