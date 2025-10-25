function displayUrls(imageUrls) {
    const urlContainer = document.getElementById('url-container');
    if (urlContainer) {
        urlContainer.innerHTML = ''; // Clear existing urls
        if (imageUrls) {
            imageUrls.forEach((url) => {
                const urlDiv = document.createElement('div');
                urlDiv.textContent = url;
                urlContainer.appendChild(urlDiv);
            });
        }
    }
}

chrome.runtime.sendMessage({action: 'getImages'});

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (changes.imageUrls) {
        displayUrls(changes.imageUrls.newValue);
    }
});

chrome.storage.local.get(['imageUrls'], (result) => {
    if (result.imageUrls) {
        displayUrls(result.imageUrls);
    }
});