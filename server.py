from flask import Flask, request, jsonify
from flask_cors import CORS
import random
import requests
import os
from text_detection import load_model_and_tokenizer, predict_single_text
from detect import load_models, process_image, process_video

app = Flask(__name__)
CORS(app)

# Load the model and tokenizer when the server starts
text_model, tokenizer, device = load_model_and_tokenizer()
clip_model, clip_processor, vit_model, vit_processor = load_models()

print("✅ All models are ready.")

@app.route('/detect', methods=['POST'])
def detect():
    data = request.get_json()
    content_type = data.get('type')
    content = data.get('content')

    print(f"Received content of type: {content_type}")
    print(f"Content: {content}")

    if not content_type or not content:
        return jsonify({'error': 'Both "type" and "content" fields are required'}), 400

    if content_type == 'text':
        # Get the AI detection confidence
        prediction, _ = predict_single_text(content, text_model, tokenizer, device)
    elif content_type in ['image', 'video']:
        try:
            response = requests.get(content, stream=True)
            response.raise_for_status()
            
            # Create a temporary file to store the content
            file_extension = '.jpg' if content_type == 'image' else '.mp4'
            temp_file_path = f'temp{file_extension}'
            with open(temp_file_path, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)
            
            if content_type == 'image':
                prediction = process_image(temp_file_path, clip_model, clip_processor, vit_model, vit_processor)
            else: # video
                prediction = process_video(temp_file_path, clip_model, clip_processor, vit_model, vit_processor)

            os.remove(temp_file_path)

        except requests.exceptions.RequestException as e:
            return jsonify({'error': f'Error downloading file: {e}'}), 400
        except Exception as e:
            return jsonify({'error': f'Error processing file: {e}'}), 500

    else:
        return jsonify({'error': 'Invalid "type" specified'}), 400

    print(f"Confidence: {prediction}")
    return jsonify({'confidence': prediction})

if __name__ == '__main__':
    app.run(port=5000, debug=True)
