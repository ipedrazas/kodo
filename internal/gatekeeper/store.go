package gatekeeper

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

// Store is the Gatekeeper's bucket: vault/ and audit/ objects. Only the
// Gatekeeper's credentials can read it; a fleet's cannot.
type Store interface {
	Get(ctx context.Context, key string) ([]byte, error)
	Put(ctx context.Context, key string, data []byte) error
	// Create writes an object only if none exists at key, else ErrExists.
	Create(ctx context.Context, key string, data []byte) error
	Delete(ctx context.Context, key string) error
	List(ctx context.Context, prefix string) ([]string, error)
}

var (
	ErrNotFound = errors.New("object not found")
	ErrExists   = errors.New("object already exists")
)

// S3Store is a Store on an S3-compatible bucket, under an optional prefix.
type S3Store struct {
	Client *s3.Client
	Bucket string
	Prefix string
}

// S3Config locates a bucket. Credentials come from the fields, or from the
// environment's AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY if they are empty.
type S3Config struct {
	// Bucket is the bucket name, optionally followed by /prefix.
	Bucket    string
	Endpoint  string
	Region    string
	AccessKey string
	SecretKey string
}

func NewS3Store(c S3Config) *S3Store {
	bucket, prefix, _ := strings.Cut(c.Bucket, "/")
	if prefix != "" && !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	region := c.Region
	if region == "" {
		region = "us-east-1"
	}
	client := s3.New(s3.Options{
		Region:       region,
		Credentials:  credentials.NewStaticCredentialsProvider(c.AccessKey, c.SecretKey, ""),
		BaseEndpoint: nilIfEmpty(c.Endpoint),
		UsePathStyle: c.Endpoint != "",
	})
	return &S3Store{Client: client, Bucket: bucket, Prefix: prefix}
}

func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return aws.String(s)
}

func (s *S3Store) key(k string) *string { return aws.String(s.Prefix + k) }

func (s *S3Store) Get(ctx context.Context, key string) ([]byte, error) {
	out, err := s.Client.GetObject(ctx, &s3.GetObjectInput{Bucket: &s.Bucket, Key: s.key(key)})
	if err != nil {
		if status(err) == http.StatusNotFound {
			return nil, ErrNotFound
		}
		return nil, err
	}
	defer func() { _ = out.Body.Close() }()
	return io.ReadAll(out.Body)
}

func (s *S3Store) Put(ctx context.Context, key string, data []byte) error {
	_, err := s.Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: &s.Bucket, Key: s.key(key), Body: bytes.NewReader(data), ContentType: aws.String("application/json"),
	})
	return err
}

func (s *S3Store) Create(ctx context.Context, key string, data []byte) error {
	_, err := s.Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: &s.Bucket, Key: s.key(key), Body: bytes.NewReader(data), ContentType: aws.String("application/json"),
		IfNoneMatch: aws.String("*"),
	})
	if code := status(err); code == http.StatusPreconditionFailed || code == http.StatusConflict {
		return ErrExists
	}
	return err
}

func (s *S3Store) Delete(ctx context.Context, key string) error {
	_, err := s.Client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &s.Bucket, Key: s.key(key)})
	return err
}

func (s *S3Store) List(ctx context.Context, prefix string) ([]string, error) {
	var keys []string
	p := s3.NewListObjectsV2Paginator(s.Client, &s3.ListObjectsV2Input{Bucket: &s.Bucket, Prefix: s.key(prefix)})
	for p.HasMorePages() {
		page, err := p.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		for _, o := range page.Contents {
			keys = append(keys, strings.TrimPrefix(aws.ToString(o.Key), s.Prefix))
		}
	}
	return keys, nil
}

func status(err error) int {
	var re *smithyhttp.ResponseError
	if errors.As(err, &re) {
		return re.HTTPStatusCode()
	}
	return 0
}

// MemStore is a Store in memory, for tests.
type MemStore struct {
	mu      sync.Mutex
	objects map[string][]byte
}

func NewMemStore() *MemStore { return &MemStore{objects: map[string][]byte{}} }

func (m *MemStore) Get(_ context.Context, key string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.objects[key]
	if !ok {
		return nil, ErrNotFound
	}
	return bytes.Clone(b), nil
}

func (m *MemStore) Put(_ context.Context, key string, data []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.objects[key] = bytes.Clone(data)
	return nil
}

func (m *MemStore) Create(_ context.Context, key string, data []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.objects[key]; ok {
		return ErrExists
	}
	m.objects[key] = bytes.Clone(data)
	return nil
}

func (m *MemStore) Delete(_ context.Context, key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.objects, key)
	return nil
}

func (m *MemStore) List(_ context.Context, prefix string) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var keys []string
	for k := range m.objects {
		if strings.HasPrefix(k, prefix) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	return keys, nil
}
