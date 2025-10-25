function displayImages(imageUrls) {
    const imageContainer = document.getElementById('image-container');
    if (imageContainer) {
        imageContainer.innerHTML = ''; // Clear existing images
        if (imageUrls) {
            imageUrls.forEach((url) => {
                const img = document.createElement('img');
                img.src = url;
                img.style.width = '100px'; // Add some basic styling
                img.style.margin = '5px';
                imageContainer.appendChild(img);
            });
        }
    }
}

chrome.runtime.sendMessage({action: 'getImages'});

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (changes.imageUrls) {
        displayImages(changes.imageUrls.newValue);
    }
});

chrome.storage.local.get(['imageUrls'], (result) => {
    if (result.imageUrls) {
        displayImages(result.imageUrls);
    }
});

//sapling only allows text
//hive is only enterprise
//copyleaks allows image and text but I cant tell pricing